import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../src/index.ts';

const request = (path, method = 'GET') => new Request('https://example.test' + path, { method });
test('public seed endpoint cannot mutate bindings or invoke AI', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await worker.fetch(request('/api/seed', method), {});
    assert.equal(response.status, 404);
  }
});
test('invalid IDs are rejected before database access', async () => {
  for (const id of ['1oops', '-1', '0', '9007199254740992', '1/2']) {
    assert.equal((await worker.fetch(request('/api/feedback/' + id), {})).status, 400);
  }
});
test('API methods and unknown routes have explicit status codes', async () => {
  assert.equal((await worker.fetch(request('/api/stats', 'POST'), {})).status, 405);
  assert.equal((await worker.fetch(request('/api/missing'), {})).status, 404);
});
test('internal errors do not disclose binding details', async () => {
  const response = await worker.fetch(request('/api/stats'), {
    CACHE: { get() { throw new Error('private database details'); } },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});
test('dashboard uses escaped text and event listeners for hostile titles', async () => {
  const html = await (await worker.fetch(request('/'), {})).text();
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
