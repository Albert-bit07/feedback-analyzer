import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const auth = { Authorization: 'Basic ' + btoa('analyst:test-only-password') };

describe('Dashboard worker', () => {
	it('serves the dashboard (unit style)', async () => {
		const request = new IncomingRequest('http://example.com', { headers: auth });
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
		const response = await SELF.fetch('https://example.com', { headers: auth });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Feedback');
	});
});

describe('read APIs with isolated local bindings', () => {
  beforeEach(async () => {
    await env.DB.exec('DROP TABLE IF EXISTS feedback');
    await env.CACHE.delete('stats');
  });
  it('returns consistent uncached stats', async () => {
    await env.DB.exec('CREATE TABLE feedback (id INTEGER PRIMARY KEY, title TEXT, description TEXT, source TEXT, user_email TEXT, sentiment TEXT, category TEXT, priority TEXT, created_at TEXT, resolved_at TEXT)');
    await env.DB.prepare("INSERT INTO feedback (title, sentiment, user_email) VALUES (?, ?, ?)").bind('Example', 'positive', 'synthetic@example.test').run();
    const first = await SELF.fetch('https://example.com/api/stats', { headers: auth });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ total: 1, avgSentiment: '8.0', unresolved: 1, repeatUsers: 0 });
    const cached = await SELF.fetch('https://example.com/api/stats', { headers: auth });
    expect(await cached.json()).toEqual({ total: 1, avgSentiment: '8.0', unresolved: 1, repeatUsers: 0 });
  });

  it('returns 404 for absent feedback', async () => {
    await env.DB.exec('CREATE TABLE feedback (id INTEGER PRIMARY KEY, title TEXT, description TEXT, source TEXT, user_email TEXT, sentiment TEXT, category TEXT, priority TEXT, created_at TEXT, resolved_at TEXT)');
    const response = await SELF.fetch('https://example.com/api/feedback/1', { headers: auth });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Feedback not found' });
  });
});


it('insight inputs include committed resolution state from D1', async () => {
  await env.DB.exec('CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, title TEXT, description TEXT, category TEXT, sentiment TEXT, created_at TEXT, resolved_at TEXT)');
  await env.DB.prepare("INSERT INTO feedback (id,title,created_at) VALUES (123,?,datetime('now'))").bind('Insight resolution fixture').run();
  const inputs: string[] = [];
  const bindings = {...env, AI: {run: async (_model: string, options: {messages: {content: string}[]}) => {
    inputs.push(options.messages[1].content);
    return {response: `Controlled result ${inputs.length}`};
  }} as unknown as Ai};
  const insights = () => worker.fetch(new Request('https://example.com/api/ai-insights', {headers: auth}), bindings);
  expect((await insights()).status).toBe(200);
  await env.DB.prepare("UPDATE feedback SET resolved_at='2026-10-25 12:00:00' WHERE id=123").run();
  expect((await insights()).status).toBe(200);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toContain('"resolved_at":null');
  expect(inputs[1]).toContain('"resolved_at":"2026-10-25 12:00:00"');
});
