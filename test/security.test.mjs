import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../src/index.ts';

const credentials = { DASHBOARD_PASSWORD: 'test-only-password' };
const request = (path, method = 'GET') => new Request('https://example.test' + path, { method, headers: { Authorization: 'Basic ' + btoa('analyst:test-only-password') } });
test('public seed endpoint cannot mutate bindings or invoke AI', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await worker.fetch(request('/api/seed', method), credentials);
    assert.equal(response.status, 404);
  }
});
test('invalid IDs are rejected before database access', async () => {
  for (const id of ['1oops', '-1', '0', '9007199254740992', '1/2']) {
    assert.equal((await worker.fetch(request('/api/feedback/' + id), credentials)).status, 400);
  }
});
test('API methods and unknown routes have explicit status codes', async () => {
  assert.equal((await worker.fetch(request('/api/stats', 'POST'), credentials)).status, 405);
  assert.equal((await worker.fetch(request('/api/missing'), credentials)).status, 404);
});
test('internal errors do not disclose binding details', async () => {
  const response = await worker.fetch(request('/api/stats'), {
    ...credentials,
    DB: { prepare() { throw new Error('private database details'); } },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});
test('dashboard uses escaped text and event listeners for hostile titles', async () => {
  const html = await (await worker.fetch(request('/'), credentials)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', children: [{ addEventListener(event, callback) { this.callback = callback; } }] });
    return elements.get(id);
  } };
  const title = `O'Reilly <img src=x onerror=alert(1)>`;
  const context = vm.createContext({ document, console, setInterval() {}, fetch: async () => ({ json: async () => [{ title, sentiment: '<svg/onload=alert(1)>', count: 2 }] }) });
  // Skip startup calls; invoke the actual renderer with a deterministic fixture.
  vm.runInContext(script.slice(0, script.indexOf('// Load all data')), context);
  await vm.runInContext('loadTopIssues()', context);
  const container = elements.get('top-issues');
  assert.ok(container.innerHTML.includes('&lt;img'));
  assert.ok(!container.innerHTML.includes('onclick='));
  assert.ok(!container.innerHTML.includes('<svg/onload'));
  vm.runInContext('showFeedbackDetail = (...args) => { globalThis.clicked = args; }', context);
  container.children[0].callback();
  assert.equal(context.clicked[1], title);
});

test('late insight generation cannot replace the cache for newer feedback state', async () => {
  let rows = [{id: 1, title: 'Login error', description: 'Cannot sign in', resolved_at: null}];
  const cache = new Map();
  let finishFirst, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const delayed = new Promise(resolve => { finishFirst = resolve; });
  let calls = 0;
  const bindings = {
    ...credentials,
    DB: { prepare() { return {all: async () => ({results: structuredClone(rows)})}; } },
    CACHE: {get: async key => cache.get(key), put: async (key, value) => { cache.set(key, value); }},
    AI: {run: async () => {
      calls++;
      if (calls === 1) { signalStarted(); return delayed; }
      return {response: 'The login problem is resolved.'};
    }},
  };
  const first = worker.fetch(request('/api/ai-insights'), bindings);
  await started;
  rows = [{...rows[0], resolved_at: '2026-10-25 12:00:00'}];
  const newer = await worker.fetch(request('/api/ai-insights'), bindings);
  assert.equal((await newer.json()).insights, 'The login problem is resolved.');
  finishFirst({response: 'The login problem is unresolved.'});
  await first;
  const cached = await worker.fetch(request('/api/ai-insights'), bindings);
  assert.equal((await cached.json()).insights, 'The login problem is resolved.');
  assert.equal(calls, 2, 'unchanged snapshot must reuse its cached result');
});

test('triage health renderer replaces stale counters when a refresh fails', async () => {
  const { triageHTML } = await import('../src/triage.ts');
  const elements = new Map();
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {textContent: '', replaceChildren() {}});
    return elements.get(id);
  }};
  let available = true;
  const context = vm.createContext({document, fetch: async () => ({ok: available, status: 503,
    json: async () => ({ready_pending:2, delayed_pending:1, processing:3, expired_leases:1,
      failed:4, completed:5, retried_jobs:6, oldest_active_age_seconds:90})})});
  const script = triageHTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.slice(0, script.indexOf('let pending = null;')), context);
  await vm.runInContext('refreshHealth()', context);
  const rendered = elements.get('processing-health');
  assert.match(rendered.textContent, /Ready: 2/);
  assert.match(rendered.textContent, /expired leases: 1/);
  assert.match(rendered.textContent, /Oldest active job: 90 seconds/);
  available = false;
  await vm.runInContext('refreshHealth()', context);
  assert.equal(rendered.textContent, 'Processing health unavailable. Refresh to retry.');
});
