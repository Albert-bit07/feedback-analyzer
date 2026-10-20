import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Dashboard worker', () => {
	it('serves the dashboard (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Feedback');
	});

	it('serves the dashboard (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Feedback');
	});
});

describe('read APIs with isolated local bindings', () => {
  it('returns matching cold and cached stats', async () => {
    await env.DB.exec('CREATE TABLE feedback (id INTEGER PRIMARY KEY, title TEXT, description TEXT, source TEXT, user_email TEXT, sentiment TEXT, category TEXT, priority TEXT, created_at TEXT, resolved_at TEXT)');
    await env.DB.prepare("INSERT INTO feedback (title, sentiment, user_email) VALUES (?, ?, ?)").bind('Example', 'positive', 'synthetic@example.test').run();
    const first = await SELF.fetch('https://example.com/api/stats');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ total: 1, avgSentiment: '8.0', unresolved: 1, repeatUsers: 0 });
    const cached = await SELF.fetch('https://example.com/api/stats');
    expect(await cached.json()).toEqual({ total: 1, avgSentiment: '8.0', unresolved: 1, repeatUsers: 0 });
  });

  it('returns 404 for absent feedback', async () => {
    await env.DB.exec('CREATE TABLE feedback (id INTEGER PRIMARY KEY, title TEXT, description TEXT, source TEXT, user_email TEXT, sentiment TEXT, category TEXT, priority TEXT, created_at TEXT, resolved_at TEXT)');
    const response = await SELF.fetch('https://example.com/api/feedback/1');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Feedback not found' });
  });
});
