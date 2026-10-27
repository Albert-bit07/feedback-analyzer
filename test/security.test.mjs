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
  let inferenceSamples = 2;
  const context = vm.createContext({document, fetch: async () => ({ok: available, status: 503,
    json: async () => ({ready_pending:2, delayed_pending:1, processing:3, expired_leases:1,
      failed:4, completed:5, retried_jobs:6, oldest_active_age_seconds:90, inference_samples:inferenceSamples, average_inference_ms:125.5, max_inference_ms:200})})});
  const script = triageHTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.slice(0, script.indexOf('let pending = null;')), context);
  await vm.runInContext('refreshHealth()', context);
  const rendered = elements.get('processing-health');
  assert.match(rendered.textContent, /Ready: 2/);
  assert.match(rendered.textContent, /Inference: 2 samples, average 125.5 ms, max 200 ms/);
  assert.match(rendered.textContent, /expired leases: 1/);
  assert.match(rendered.textContent, /Oldest active job: 90 seconds/);
  inferenceSamples = 0;
  await vm.runInContext('refreshHealth()', context);
  assert.match(rendered.textContent, /Inference: no samples/);
  available = false;
  await vm.runInContext('refreshHealth()', context);
  assert.equal(rendered.textContent, 'Processing health unavailable. Refresh to retry.');
});

test('correction editor sends version guards and retains edits after a conflict', async () => {
  const { triageHTML } = await import('../src/triage.ts');
  const element = () => ({children: [], value:'', textContent:'', setAttribute() {}, append(...children) {this.children.push(...children);}});
  let submitted;
  const context = vm.createContext({
    document: {getElementById: element, createElement: element},
    row: {id:7,input_hash:'a'.repeat(64),correction_revision:2,analysis_summary:'Model summary',analysis_category:'UI',analysis_sentiment:'negative'},
    fetch: async (_path, options) => { submitted = JSON.parse(options.body); return {ok:false,status:409,json:async()=>({error:'Feedback or correction changed. Refresh before saving again.'})}; },
  });
  const script = triageHTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.slice(0, script.indexOf('let pending = null;')), context);
  const section = vm.runInContext('correctionEditor(row)', context);
  const form = section.children[1];
  form.children[2].children[0].value = 'My reviewed summary';
  form.children[3].children[0].value = 'Checked the report';
  await form.onsubmit({preventDefault() {}});
  assert.equal(submitted.input_hash, 'a'.repeat(64));
  assert.equal(submitted.expected_revision, 2);
  assert.equal(submitted.summary, 'My reviewed summary');
  assert.equal(form.children[2].children[0].value, 'My reviewed summary');
  assert.match(form.children[5].textContent, /Refresh before saving/);
  assert.equal(form.children[4].disabled, false);
});

test('triage pagination preserves the visible page on failure and refreshes its cursor', async () => {
  const { triageHTML } = await import('../src/triage.ts');
  const element = () => ({children:[],textContent:'',append(...children){this.children.push(...children);},replaceChildren(){this.children=[];}});
  const elements = new Map();
  const paths = [];
  let fail = false;
  const context = vm.createContext({document:{createElement:element,getElementById(id){if(!elements.has(id)) elements.set(id,element());return elements.get(id);}},
    fetch:async path=>{
      paths.push(path);
      if(path==='/api/processing/health') return {ok:true,json:async()=>({})};
      if(fail) return {ok:false,status:503,json:async()=>({error:'Try again'})};
      const ids = path.includes('?') ? [5,4,3,2,1] : Array.from({length:100},(_,i)=>105-i);
      return {ok:true,json:async()=>ids.map(id=>({id,title:'Report',description:'Body',source:'test'}))};
    }});
  const script = triageHTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.slice(0,script.indexOf('let pending = null;')),context);
  await vm.runInContext('refresh()',context);
  assert.equal(elements.get('items').children.length,100);
  assert.equal(elements.get('newer').disabled,true);
  fail=true;
  await elements.get('older').onclick();
  assert.equal(elements.get('items').children.length,100);
  assert.equal(elements.get('newer').disabled,true);
  assert.equal(elements.get('older').disabled,false);
  fail=false;
  await elements.get('older').onclick();
  assert.equal(paths.at(-1),'/api/triage?before=6');
  assert.equal(elements.get('items').children.length,5);
  assert.equal(elements.get('older').disabled,true);
  await vm.runInContext('refresh()',context);
  assert.equal(paths.at(-1),'/api/triage?before=6');
  await elements.get('newer').onclick();
  assert.equal(paths.at(-1),'/api/triage');
  assert.equal(elements.get('items').children.length,100);
});

test('overall sentiment displays missing classifications and its sample denominator', async () => {
  const html = await (await worker.fetch(request('/'), credentials)).text();
  const start = html.indexOf('async function loadStats()');
  const end = html.indexOf('// Load top issues', start);
  const elements = new Map();
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  }};
  let stats = {total:3,unresolved:3,repeatUsers:0,avgSentiment:null,sentimentSamples:0,unclassified:3};
  const context = vm.createContext({document,API_BASE:'',console,fetch:async()=>({ok:true,json:async()=>stats})});
  vm.runInContext(html.slice(start,end),context);
  await vm.runInContext('loadStats()',context);
  assert.equal(elements.get('stat-sentiment').textContent,'No classifications');
  assert.match(elements.get('stat-sentiment').title,/0 classified reports; 3 unclassified/);
  stats = {...stats,avgSentiment:'5.0',sentimentSamples:2,unclassified:1};
  await vm.runInContext('loadStats()',context);
  assert.equal(elements.get('stat-sentiment').textContent,'5.0/10');
  assert.match(elements.get('stat-sentiment').title,/2 classified reports; 1 unclassified/);
});

test('stats refresh clears stale values on HTTP, network and JSON failures', async () => {
  const html = await (await worker.fetch(request('/'), credentials)).text();
  const start = html.indexOf('async function loadStats()');
  const end = html.indexOf('// Load top issues', start);
  for (const failure of ['http','network','json']) {
    const elements = new Map();
    const document = {getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }};
    let failing = false;
    const context = vm.createContext({document,API_BASE:'',console:{error(){}},fetch:async()=>{
      if (failing && failure==='network') throw new Error('offline');
      return {ok:!(failing && failure==='http'),status:503,json:async()=>{
        if (failing && failure==='json') throw new SyntaxError('invalid JSON');
        return {total:9,unresolved:2,repeatUsers:1,avgSentiment:'8.0',sentimentSamples:9,unclassified:0};
      }};
    }});
    vm.runInContext(html.slice(start,end),context);
    await vm.runInContext('loadStats()',context);
    assert.equal(elements.get('stat-total').textContent,9);
    failing = true;
    await vm.runInContext('loadStats()',context);
    for (const id of ['stat-total','stat-sentiment','stat-unresolved','stat-repeat']) {
      assert.equal(elements.get(id).textContent,'Unavailable',failure+': '+id);
    }
    assert.equal(elements.get('stat-sentiment').title,'Refresh failed. Retry when the service is available.');
    failing = false;
    await vm.runInContext('loadStats()',context);
    assert.equal(elements.get('stat-total').textContent,9);
  }
});
