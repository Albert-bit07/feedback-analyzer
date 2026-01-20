export interface Env {
	DB: D1Database;
	AI: Ai;
	CACHE: KVNamespace;
}

interface Feedback {
	id: number;
	title: string;
	description: string;
	source: string;
	user_email: string | null;
	user_id?: string | null;
	sentiment: string | null;
	category: string | null;
	ai_themes?: string | null; // JSON array of themes
	created_at: string;
	resolved_at: string | null;
	priority: string;
	upvotes?: number;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS headers for API requests
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// API Routes
			if (url.pathname === '/api/stats') {
				return await getStats(env, corsHeaders);
			}

			if (url.pathname === '/api/top-issues') {
				return await getTopIssues(env, corsHeaders);
			}

			if (url.pathname === '/api/recent') {
				return await getRecentIssues(env, corsHeaders);
			}

			if (url.pathname === '/api/repeat-users') {
				return await getRepeatUsers(env, corsHeaders);
			}

			if (url.pathname === '/api/longest-unresolved') {
				return await getLongestUnresolved(env, corsHeaders);
			}

			if (url.pathname === '/api/ai-insights') {
				return await getAIInsights(env, corsHeaders);
			}

			if (url.pathname.startsWith('/api/feedback/')) {
				const id = url.pathname.split('/').pop();
				return await getFeedbackDetail(env, parseInt(id || '0'), corsHeaders);
			}

			if (url.pathname === '/api/seed') {
				return await seedDatabase(env, corsHeaders);
			}

			// Serve Dashboard HTML
			return new Response(getDashboardHTML(), {
				headers: {
					'Content-Type': 'text/html',
					...corsHeaders,
				},
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: (error as Error).message }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}
	},
};

// Get overall stats
async function getStats(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const cacheKey = 'stats';
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		return new Response(cached, {
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	const totalResult = await env.DB.prepare('SELECT COUNT(*) as count FROM feedback').first();
	const unresolvedResult = await env.DB.prepare('SELECT COUNT(*) as count FROM feedback WHERE resolved_at IS NULL').first();
	const avgSentiment = await env.DB.prepare(`
		SELECT 
			CASE 
				WHEN sentiment = 'positive' THEN 8.0
				WHEN sentiment = 'neutral' THEN 5.0
				ELSE 2.0
			END as score
		FROM feedback
	`).all();

	const avgScore = avgSentiment.results.length > 0
		? (avgSentiment.results.reduce((sum: number, row: any) => sum + row.score, 0) / avgSentiment.results.length).toFixed(1)
		: '0.0';

	const repeatUsersResult = await env.DB.prepare(`
		SELECT COUNT(DISTINCT user_email) as count 
		FROM feedback 
		WHERE user_email IN (
			SELECT user_email 
			FROM feedback 
			GROUP BY user_email 
			HAVING COUNT(*) > 1
		)
	`).first();

	const stats = {
		total: totalResult?.count || 0,
		avgSentiment: avgScore,
		unresolved: unresolvedResult?.count || 0,
		repeatUsers: repeatUsersResult?.count || 0,
	};

	const response = JSON.stringify(stats);
	await env.CACHE.put(cacheKey, response, { expirationTtl: 300 }); // Cache for 5 minutes

	return new Response(response, {
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

// Get top ranking issues (by count)
async function getTopIssues(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const cacheKey = 'top-issues';
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		return new Response(cached, {
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	const result = await env.DB.prepare(`
		SELECT 
			title,
			COUNT(*) as count,
			sentiment
		FROM feedback
		WHERE resolved_at IS NULL
		GROUP BY title
		ORDER BY count DESC
		LIMIT 5
	`).all();

	const response = JSON.stringify(result.results);
	await env.CACHE.put(cacheKey, response, { expirationTtl: 300 });

	return new Response(response, {
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

// Get most recent issues
async function getRecentIssues(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const result = await env.DB.prepare(`
		SELECT 
			id,
			title,
			description,
			source,
			created_at,
			sentiment
		FROM feedback
		ORDER BY created_at DESC
		LIMIT 5
	`).all();

	return new Response(JSON.stringify(result.results), {
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

// Get users with multiple complaints
async function getRepeatUsers(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const cacheKey = 'repeat-users';
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		return new Response(cached, {
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	const result = await env.DB.prepare(`
		SELECT 
			user_email,
			COUNT(*) as complaint_count,
			GROUP_CONCAT(title, ' | ') as issues
		FROM feedback
		WHERE resolved_at IS NULL
			AND user_email IS NOT NULL
		GROUP BY user_email
		HAVING COUNT(*) > 1
		ORDER BY complaint_count DESC
		LIMIT 5
	`).all();

	const response = JSON.stringify(result.results);
	await env.CACHE.put(cacheKey, response, { expirationTtl: 300 });

	return new Response(response, {
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

// Get longest unresolved issues
async function getLongestUnresolved(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const cacheKey = 'longest-unresolved';
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		return new Response(cached, {
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	const result = await env.DB.prepare(`
		SELECT 
			title,
			created_at,
			source,
			CAST((julianday('now') - julianday(created_at)) AS INTEGER) as days_open
		FROM feedback
		WHERE resolved_at IS NULL
		ORDER BY created_at ASC
		LIMIT 5
	`).all();

	const response = JSON.stringify(result.results);
	await env.CACHE.put(cacheKey, response, { expirationTtl: 300 });

	return new Response(response, {
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

// Get individual feedback detail
async function getFeedbackDetail(env: Env, id: number, corsHeaders: Record<string, string>): Promise<Response> {
	const result = await env.DB.prepare(`
		SELECT 
			id,
			title,
			description,
			source,
			user_email,
			sentiment,
			category,
			priority,
			created_at,
			resolved_at
		FROM feedback
		WHERE id = ?
	`).bind(id).first();

	if (!result) {
		return new Response(JSON.stringify({ error: 'Feedback not found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	// Get all feedback from this user for context
	const userHistory = result.user_email
		? await env.DB.prepare(`
			SELECT id, title, created_at, sentiment, resolved_at
			FROM feedback
			WHERE user_email = ?
			ORDER BY created_at DESC
			LIMIT 10
		`).bind(result.user_email).all()
		: { results: [] };

	const detail = {
		...result,
		userHistory: userHistory.results,
	};

	return new Response(JSON.stringify(detail), {
		headers: { 'Content-Type': 'application/json', ...corsHeaders },
	});
}

// Analyze sentiment using Workers AI
async function analyzeSentiment(env: Env, text: string): Promise<string> {
	try {
		const aiResponse = await env.AI.run('@cf/huggingface/distilbert-sst-2-int8', {
			text: text.substring(0, 500), // Limit text length
		});

		const label = (aiResponse as any).label || 'NEGATIVE';
		const score = (aiResponse as any).score || 0;

		// Convert to our sentiment format
		if (label === 'POSITIVE' && score > 0.6) return 'positive';
		if (label === 'NEGATIVE' && score > 0.6) return 'negative';
		return 'neutral';
	} catch (error) {
		// Fallback sentiment detection based on keywords
		const lowerText = text.toLowerCase();
		if (lowerText.includes('great') || lowerText.includes('love') || lowerText.includes('awesome') || lowerText.includes('excellent')) {
			return 'positive';
		}
		if (lowerText.includes('fail') || lowerText.includes('error') || lowerText.includes('broken') || lowerText.includes('slow') || lowerText.includes('issue') || lowerText.includes('problem')) {
			return 'negative';
		}
		return 'neutral';
	}
}

// Seed database with mock data using Workers AI for sentiment
async function seedDatabase(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	// Clear existing cache
	await env.CACHE.delete('stats');
	await env.CACHE.delete('top-issues');
	await env.CACHE.delete('repeat-users');
	await env.CACHE.delete('longest-unresolved');
	await env.CACHE.delete('ai-insights');

	// Mock feedback data (20-30 entries with varied volumes and sources)
	const mockFeedback = [
		{ title: 'Dashboard loading takes 5+ seconds', description: 'The dashboard takes way too long to load. Sometimes it times out completely.', source: 'Discord', user_email: 'dev@company.com', created_at: '-45 days' },
		{ title: 'Dashboard loading takes 5+ seconds', description: 'Dashboard is extremely slow to load', source: 'Support Ticket', user_email: 'pm@startup.io', created_at: '-40 days' },
		{ title: 'Dashboard loading takes 5+ seconds', description: 'Performance issue with dashboard', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-35 days' },
		{ title: 'Dashboard loading takes 5+ seconds', description: 'Dashboard loading is slow', source: 'Twitter', user_email: 'user1@email.com', created_at: '-30 days' },
		{ title: 'Dashboard loading takes 5+ seconds', description: 'Dashboard timeout errors', source: 'Discord', user_email: 'dev@company.com', created_at: '-25 days' },
		{ title: 'Workers AI timeout errors on large files', description: 'Workers AI times out when processing files larger than 5MB', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-38 days' },
		{ title: 'Workers AI timeout errors on large files', description: 'Large file processing fails', source: 'Support Ticket', user_email: 'pm@startup.io', created_at: '-33 days' },
		{ title: 'Workers AI timeout errors on large files', description: 'Timeout issue with AI service', source: 'Discord', user_email: 'dev@company.com', created_at: '-28 days' },
		{ title: 'D1 migrations fail silently', description: 'D1 migrations fail without error messages', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-42 days' },
		{ title: 'D1 migrations fail silently', description: 'Migration errors are not reported properly', source: 'Support Ticket', user_email: 'pm@startup.io', created_at: '-37 days' },
		{ title: 'KV cache invalidation not working', description: 'Cache does not invalidate when keys are updated', source: 'Discord', user_email: 'dev@company.com', created_at: '-15 days' },
		{ title: 'KV cache invalidation not working', description: 'Cache invalidation broken', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-12 days' },
		{ title: 'Cannot deploy to Workers', description: 'Deployment fails with cryptic error message', source: 'Discord', user_email: 'dev@company.com', created_at: '-5 minutes' },
		{ title: 'Wrangler CLI crashes on Windows', description: 'CLI crashes when running deploy command on Windows 11', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-44 days' },
		{ title: 'Documentation unclear on D1 setup', description: 'Cannot find clear instructions for D1 database setup', source: 'Support Ticket', user_email: 'pm@startup.io', created_at: '-39 days' },
		{ title: 'R2 CORS configuration unclear', description: 'Cannot figure out CORS setup for R2 buckets', source: 'Support Ticket', user_email: 'pm@startup.io', created_at: '-36 days' },
		{ title: 'API performance degraded', description: 'API is slower than usual. Response times have increased significantly', source: 'Discord', user_email: 'dev@company.com', created_at: '-3 days' },
		{ title: 'Great new AI feature!', description: 'Love the new AI models. They work really well!', source: 'Twitter', user_email: 'fan@email.com', created_at: '-1 hour' },
		{ title: 'Love the new features!', description: 'Great updates this month. Keep up the good work!', source: 'Twitter', user_email: 'happy@user.com', created_at: '-1 day' },
		{ title: 'KV storage quota exceeded', description: 'Need more storage for KV namespace', source: 'Support Ticket', user_email: 'dev@company.com', created_at: '-12 minutes' },
		{ title: 'Database migration failed', description: 'D1 migration script not working as expected', source: 'Support Ticket', user_email: 'pm@startup.io', created_at: '-2 hours' },
		{ title: 'Workers AI rate limiting too strict', description: 'Hit rate limits with Workers AI too quickly', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-31 days' },
		{ title: 'Dashboard UI confusing', description: 'Hard to find deployment settings in the dashboard', source: 'Twitter', user_email: 'user1@email.com', created_at: '-2 days' },
		{ title: 'Workers AI is slow', description: 'AI inference takes too long to complete', source: 'GitHub', user_email: 'eng@tech.com', created_at: '-29 days' },
		{ title: 'Excellent documentation update', description: 'The latest docs are much clearer. Thank you!', source: 'Twitter', user_email: 'happy@user.com', created_at: '-6 hours' },
	];

	const inserted = [];
	const errors = [];

	for (const feedback of mockFeedback) {
		try {
			// Use Workers AI to analyze sentiment
			const sentiment = await analyzeSentiment(env, `${feedback.title} ${feedback.description}`);
			
			// Determine priority based on sentiment and keywords
			let priority = 'medium';
			if (sentiment === 'negative' && (feedback.title.includes('error') || feedback.title.includes('fail') || feedback.title.includes('crash'))) {
				priority = 'high';
			} else if (sentiment === 'positive') {
				priority = 'low';
			}

			// Determine category
			let category = 'general';
			if (feedback.title.includes('Dashboard') || feedback.title.includes('UI')) category = 'ux';
			else if (feedback.title.includes('Workers AI') || feedback.title.includes('AI')) category = 'ai';
			else if (feedback.title.includes('D1') || feedback.title.includes('migration') || feedback.title.includes('Database')) category = 'database';
			else if (feedback.title.includes('KV') || feedback.title.includes('cache')) category = 'storage';
			else if (feedback.title.includes('API') || feedback.title.includes('performance') || feedback.title.includes('slow')) category = 'performance';
			else if (feedback.title.includes('Wrangler') || feedback.title.includes('CLI')) category = 'tooling';
			else if (feedback.title.includes('documentation') || feedback.title.includes('CORS')) category = 'docs';

			const result = await env.DB.prepare(`
				INSERT INTO feedback (title, description, source, user_email, sentiment, category, priority, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
			`).bind(
				feedback.title,
				feedback.description,
				feedback.source,
				feedback.user_email,
				sentiment,
				category,
				priority,
				feedback.created_at
			).run();

			inserted.push({ id: result.meta.last_row_id, title: feedback.title, sentiment });
		} catch (error) {
			errors.push({ title: feedback.title, error: (error as Error).message });
		}
	}

	return new Response(
		JSON.stringify({
			message: `Seeded ${inserted.length} feedback entries`,
			inserted: inserted.length,
			errors: errors.length,
			details: {
				successful: inserted,
				failed: errors,
			},
		}),
		{
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		}
	);
}

// Get AI-powered insights
async function getAIInsights(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const cacheKey = 'ai-insights';
	const cached = await env.CACHE.get(cacheKey);
	if (cached) {
		return new Response(cached, {
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	// Get sample of recent feedback for AI analysis
	const recentFeedback = await env.DB.prepare(`
		SELECT title, description, category, sentiment, created_at
		FROM feedback
		WHERE created_at > datetime('now', '-7 days')
		ORDER BY created_at DESC
		LIMIT 20
	`).all();

	const feedbackText = recentFeedback.results
		.map((f: any) => `${f.title}: ${f.description || 'No description'}`)
		.join('\n');

	try {
		const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			messages: [
				{
					role: 'system',
					content: 'You are a product manager analyzing customer feedback. Provide 3 concise insights about trends, patterns, or urgent issues. Each insight should be 1-2 sentences.',
				},
				{
					role: 'user',
					content: `Analyze this customer feedback and provide 3 key insights:\n\n${feedbackText}`,
				},
			],
		});

		const insights = {
			insights: (aiResponse as any).response || 'No insights available at this time.',
			generated_at: new Date().toISOString(),
		};

		const response = JSON.stringify(insights);
		await env.CACHE.put(cacheKey, response, { expirationTtl: 600 }); // Cache for 10 minutes

		return new Response(response, {
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				insights: 'AI analysis temporarily unavailable. Using cached data.',
				generated_at: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			}
		);
	}
}

// Dashboard HTML
function getDashboardHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Feedback Intelligence Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.5s ease-out; }
        .loading { opacity: 0.5; pointer-events: none; }
    </style>
</head>
<body class="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 min-h-screen p-6">
    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <div class="mb-8 fade-in">
            <h1 class="text-4xl font-bold text-white mb-2">Feedback Intelligence Dashboard</h1>
            <p class="text-slate-400">Real-time aggregation and analysis of customer feedback</p>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8 fade-in">
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6">
                <div class="text-sm text-slate-400 mb-1">Total Feedback</div>
                <div class="text-2xl font-bold text-white" id="stat-total">-</div>
            </div>
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6">
                <div class="text-sm text-slate-400 mb-1">Avg Sentiment</div>
                <div class="text-2xl font-bold text-white" id="stat-sentiment">-</div>
            </div>
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6">
                <div class="text-sm text-slate-400 mb-1">Unresolved</div>
                <div class="text-2xl font-bold text-white" id="stat-unresolved">-</div>
            </div>
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6">
                <div class="text-sm text-slate-400 mb-1">Repeat Users</div>
                <div class="text-2xl font-bold text-white" id="stat-repeat">-</div>
            </div>
        </div>

        <!-- Main Grid -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <!-- Top Ranking Issues -->
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6 fade-in">
                <h2 class="text-xl font-bold text-white mb-4">🔥 Top Ranking Issues</h2>
                <div id="top-issues" class="space-y-3">
                    <div class="text-slate-400 text-center py-8">Loading...</div>
                </div>
            </div>

            <!-- Most Recent -->
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6 fade-in">
                <h2 class="text-xl font-bold text-white mb-4">⏱️ Most Recent Issues</h2>
                <div id="recent-issues" class="space-y-3">
                    <div class="text-slate-400 text-center py-8">Loading...</div>
                </div>
            </div>

            <!-- Repeat Users -->
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6 fade-in">
                <h2 class="text-xl font-bold text-white mb-4">👥 Users with Multiple Complaints</h2>
                <div id="repeat-users" class="space-y-3">
                    <div class="text-slate-400 text-center py-8">Loading...</div>
                </div>
            </div>

            <!-- Longest Unresolved -->
            <div class="bg-slate-800/50 backdrop-blur border border-slate-700 rounded-lg p-6 fade-in">
                <h2 class="text-xl font-bold text-white mb-4">⚠️ Longest Without Fix</h2>
                <div id="longest-unresolved" class="space-y-3">
                    <div class="text-slate-400 text-center py-8">Loading...</div>
                </div>
            </div>
        </div>

        <!-- AI Insights -->
        <div class="bg-gradient-to-r from-blue-900/30 to-purple-900/30 backdrop-blur border border-blue-700/50 rounded-lg p-6 fade-in">
            <h2 class="text-xl font-bold text-white mb-4">🤖 AI-Powered Insights</h2>
            <div id="ai-insights" class="text-slate-300">
                <div class="text-slate-400">Generating insights...</div>
            </div>
        </div>
    </div>

    <script>
        const API_BASE = '';

        // Utility functions
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function timeAgo(dateString) {
            const date = new Date(dateString);
            const now = new Date();
            const seconds = Math.floor((now - date) / 1000);
            
            if (seconds < 60) return seconds + ' sec ago';
            if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
            if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
            return Math.floor(seconds / 86400) + ' days ago';
        }

        function getSentimentColor(sentiment) {
            if (sentiment === 'positive') return 'bg-green-500/20 text-green-300';
            if (sentiment === 'negative') return 'bg-red-500/20 text-red-300';
            return 'bg-yellow-500/20 text-yellow-300';
        }

        function getPriorityColor(priority) {
            if (priority === 'high') return 'bg-red-500/20 text-red-300';
            if (priority === 'medium') return 'bg-yellow-500/20 text-yellow-300';
            return 'bg-blue-500/20 text-blue-300';
        }

        // Modal for feedback detail
        function showModal(content) {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4';
            modal.innerHTML = \`
                <div class="bg-slate-800 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-slate-700">
                    <div class="sticky top-0 bg-slate-800 border-b border-slate-700 p-4 flex justify-between items-center">
                        <h2 class="text-xl font-bold text-white">Feedback Details</h2>
                        <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-white">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                            </svg>
                        </button>
                    </div>
                    <div class="p-6">\${content}</div>
                </div>
            \`;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.remove();
            });
        }

        // Load feedback detail
        async function loadFeedbackDetail(id) {
            try {
                const res = await fetch(API_BASE + '/api/feedback/' + id);
                const feedback = await res.json();
                
                const historyHtml = feedback.userHistory && feedback.userHistory.length > 1
                    ? \`
                        <div class="mt-6 pt-6 border-t border-slate-700">
                            <h3 class="text-lg font-semibold text-white mb-3">User History</h3>
                            <div class="space-y-2">
                                \${feedback.userHistory.map(h => \`
                                    <div class="bg-slate-700/50 rounded p-3">
                                        <div class="flex items-center justify-between">
                                            <span class="text-white text-sm">\${h.title}</span>
                                            <div class="flex items-center gap-2">
                                                <span class="text-xs px-2 py-0.5 rounded \${getSentimentColor(h.sentiment)}">
                                                    \${h.sentiment}
                                                </span>
                                                <span class="text-xs text-slate-400">\${timeAgo(h.created_at)}</span>
                                                \${h.resolved_at ? '<span class="text-xs text-green-400">Resolved</span>' : ''}
                                            </div>
                                        </div>
                                    </div>
                                \`).join('')}
                            </div>
                        </div>
                    \`
                    : '';

                const content = \`
                    <div>
                        <h3 class="text-2xl font-bold text-white mb-4">\${escapeHtml(feedback.title)}</h3>
                        <div class="space-y-4">
                            <div>
                                <div class="text-sm text-slate-400 mb-1">Description</div>
                                <div class="text-white">\${feedback.description ? escapeHtml(feedback.description) : 'No description provided'}</div>
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <div class="text-sm text-slate-400 mb-1">Source</div>
                                    <span class="text-white">\${escapeHtml(feedback.source)}</span>
                                </div>
                                <div>
                                    <div class="text-sm text-slate-400 mb-1">User</div>
                                    <span class="text-white">\${feedback.user_email || 'Anonymous'}</span>
                                </div>
                                <div>
                                    <div class="text-sm text-slate-400 mb-1">Sentiment</div>
                                    <span class="text-xs px-2 py-1 rounded \${getSentimentColor(feedback.sentiment)}">
                                        \${feedback.sentiment || 'unknown'}
                                    </span>
                                </div>
                                <div>
                                    <div class="text-sm text-slate-400 mb-1">Priority</div>
                                    <span class="text-xs px-2 py-1 rounded \${getPriorityColor(feedback.priority)}">
                                        \${feedback.priority || 'medium'}
                                    </span>
                                </div>
                                <div>
                                    <div class="text-sm text-slate-400 mb-1">Category</div>
                                    <span class="text-white">\${escapeHtml(feedback.category || 'uncategorized')}</span>
                                </div>
                                <div>
                                    <div class="text-sm text-slate-400 mb-1">Created</div>
                                    <span class="text-white">\${new Date(feedback.created_at).toLocaleString()}</span>
                                </div>
                            </div>
                            \${feedback.resolved_at 
                                ? \`<div class="bg-green-500/20 border border-green-500/50 rounded p-3">
                                    <div class="text-sm text-green-300">Resolved on \${new Date(feedback.resolved_at).toLocaleString()}</div>
                                </div>\`
                                : '<div class="bg-orange-500/20 border border-orange-500/50 rounded p-3"><div class="text-sm text-orange-300">Unresolved</div></div>'
                            }
                            \${historyHtml}
                        </div>
                    </div>
                \`;
                showModal(content);
            } catch (error) {
                alert('Error loading feedback details');
            }
        }

        // Show feedback detail for top issues (aggregated view)
        function showFeedbackDetail(id, title, category, sentiment, count) {
            const content = \`
                <div>
                    <h3 class="text-2xl font-bold text-white mb-4">\${escapeHtml(title)}</h3>
                    <div class="space-y-4">
                        <div class="bg-slate-700/50 rounded p-4">
                            <div class="text-sm text-slate-400 mb-1">Total Mentions</div>
                            <div class="text-3xl font-bold text-white">\${count}</div>
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <div class="text-sm text-slate-400 mb-1">Category</div>
                                <span class="text-white">\${escapeHtml(category || 'uncategorized')}</span>
                            </div>
                            <div>
                                <div class="text-sm text-slate-400 mb-1">Sentiment</div>
                                <span class="text-xs px-2 py-1 rounded \${getSentimentColor(sentiment)}">
                                    \${sentiment || 'unknown'}
                                </span>
                            </div>
                        </div>
                        <div class="bg-blue-500/20 border border-blue-500/50 rounded p-3">
                            <div class="text-sm text-blue-300">This is an aggregated view of multiple feedback entries with the same title. Consider investigating this as a high-priority issue.</div>
                        </div>
                    </div>
                </div>
            \`;
            showModal(content);
        }

        // Load stats
        async function loadStats() {
            try {
                const res = await fetch(API_BASE + '/api/stats');
                const stats = await res.json();
                document.getElementById('stat-total').textContent = stats.total;
                document.getElementById('stat-sentiment').textContent = stats.avgSentiment + '/10';
                document.getElementById('stat-unresolved').textContent = stats.unresolved;
                document.getElementById('stat-repeat').textContent = stats.repeatUsers;
            } catch (error) {
                console.error('Error loading stats:', error);
            }
        }

        // Load top issues
        async function loadTopIssues() {
            try {
                const res = await fetch(API_BASE + '/api/top-issues');
                const issues = await res.json();
                const container = document.getElementById('top-issues');
                
                container.innerHTML = issues.map((issue, idx) => \`
                    <div class="bg-slate-700/50 rounded-lg p-4 hover:bg-slate-700 transition-colors cursor-pointer" 
                         onclick="showFeedbackDetail(null, '\${escapeHtml(issue.title)}', '', '\${escapeHtml(issue.sentiment || '')}', '\${issue.count}')">
                        <div class="flex items-start justify-between mb-2">
                            <div class="flex items-start gap-3 flex-1">
                                <div class="bg-slate-600 text-white text-sm font-bold rounded px-2 py-1 mt-0.5">
                                    #\${idx + 1}
                                </div>
                                <div class="flex-1">
                                    <h3 class="text-white font-medium">\${escapeHtml(issue.title)}</h3>
                                    <div class="flex items-center gap-2 mt-1 flex-wrap">
                                        <span class="text-sm text-slate-400">\${issue.count} mentions</span>
                                        \${issue.sentiment ? \`<span class="text-xs px-2 py-0.5 rounded \${getSentimentColor(issue.sentiment)}">
                                            \${issue.sentiment}
                                        </span>\` : ''}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                document.getElementById('top-issues').innerHTML = '<div class="text-red-400 text-center py-8">Error loading data</div>';
            }
        }

        // Load recent issues
        async function loadRecentIssues() {
            try {
                const res = await fetch(API_BASE + '/api/recent');
                const issues = await res.json();
                const container = document.getElementById('recent-issues');
                
                container.innerHTML = issues.map(issue => \`
                    <div class="bg-slate-700/50 rounded-lg p-4 hover:bg-slate-700 transition-colors cursor-pointer" 
                         onclick="loadFeedbackDetail(\${issue.id})">
                        <div class="flex items-start justify-between mb-2">
                            <h3 class="text-white font-medium flex-1">\${issue.title}</h3>
                            \${issue.sentiment ? \`<span class="text-xs px-2 py-1 rounded \${getSentimentColor(issue.sentiment)}">
                                \${issue.sentiment}
                            </span>\` : ''}
                        </div>
                        \${issue.description ? \`<p class="text-sm text-slate-400 mb-2">\${escapeHtml(issue.description.substring(0, 100))}\${issue.description.length > 100 ? '...' : ''}</p>\` : ''}
                        <div class="flex items-center gap-2 text-sm text-slate-400">
                            <span class="bg-slate-600 px-2 py-0.5 rounded text-xs">\${issue.source}</span>
                            <span>•</span>
                            <span>\${timeAgo(issue.created_at)}</span>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                document.getElementById('recent-issues').innerHTML = '<div class="text-red-400 text-center py-8">Error loading data</div>';
            }
        }

        // Load repeat users
        async function loadRepeatUsers() {
            try {
                const res = await fetch(API_BASE + '/api/repeat-users');
                const users = await res.json();
                const container = document.getElementById('repeat-users');
                
                container.innerHTML = users.map(user => \`
                    <div class="bg-slate-700/50 rounded-lg p-4 hover:bg-slate-700 transition-colors">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex-1">
                                <h3 class="text-white font-medium">\${user.user_email}</h3>
                                \${user.issues ? \`<p class="text-sm text-slate-400 mt-1">\${escapeHtml(user.issues.split(' | ').slice(0, 2).join(', '))}\${user.issues.split(' | ').length > 2 ? '...' : ''}</p>\` : ''}
                            </div>
                            <div class="bg-purple-500/20 text-purple-300 px-3 py-1 rounded-full text-sm font-bold">
                                \${user.complaint_count} issues
                            </div>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                document.getElementById('repeat-users').innerHTML = '<div class="text-red-400 text-center py-8">Error loading data</div>';
            }
        }

        // Load longest unresolved
        async function loadLongestUnresolved() {
            try {
                const res = await fetch(API_BASE + '/api/longest-unresolved');
                const issues = await res.json();
                const container = document.getElementById('longest-unresolved');
                
                container.innerHTML = issues.map(issue => \`
                    <div class="bg-slate-700/50 rounded-lg p-4 hover:bg-slate-700 transition-colors">
                        <div class="flex items-start justify-between mb-2">
                            <div class="flex-1">
                                <h3 class="text-white font-medium mb-2">\${issue.title}</h3>
                                <div class="flex items-center gap-2 text-sm text-slate-400">
                                    <span class="bg-slate-600 px-2 py-0.5 rounded text-xs">\${issue.source}</span>
                                    <span>•</span>
                                    <span>\${timeAgo(issue.created_at)}</span>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="text-2xl font-bold text-orange-400">\${issue.days_open}</div>
                                <div class="text-xs text-slate-400">days</div>
                            </div>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                document.getElementById('longest-unresolved').innerHTML = '<div class="text-red-400 text-center py-8">Error loading data</div>';
            }
        }

        // Load AI insights
        async function loadAIInsights() {
            try {
                const res = await fetch(API_BASE + '/api/ai-insights');
                const data = await res.json();
                const container = document.getElementById('ai-insights');
                
                const insights = data.insights.split('\\n').filter(line => line.trim());
                container.innerHTML = \`
                    <div class="space-y-3">
                        \${insights.map(insight => \`
                            <p class="flex items-start gap-2">
                                <span class="text-blue-400 mt-1">•</span>
                                <span>\${insight}</span>
                            </p>
                        \`).join('')}
                    </div>
                    <div class="text-xs text-slate-500 mt-4">Generated: \${new Date(data.generated_at).toLocaleString()}</div>
                \`;
            } catch (error) {
                document.getElementById('ai-insights').innerHTML = '<div class="text-slate-400">AI insights temporarily unavailable</div>';
            }
        }

        // Load all data
        async function loadAll() {
            await Promise.all([
                loadStats(),
                loadTopIssues(),
                loadRecentIssues(),
                loadRepeatUsers(),
                loadLongestUnresolved(),
                loadAIInsights()
            ]);
        }

        // Initial load
        loadAll();

        // Refresh every 30 seconds
        setInterval(loadAll, 30000);
    </script>
</body>
</html>`;
}