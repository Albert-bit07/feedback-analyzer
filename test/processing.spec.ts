import worker from '../src/index';
import correctionMigration from '../migrations/0003_corrections.sql?raw';
import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import first from '../migrations/0001_ingestion.sql?raw';
import second from '../migrations/0002_processing.sql?raw';
import { MODEL, PROMPT_VERSION, processOne, withTimeout, validateAnalysis } from '../src/processing';
import { processingHealth } from '../src/processing_health';
const auth = { Authorization: 'Basic '+btoa('analyst:test-only-password') };
const analysis = { sentiment:'negative',category:'performance',summary:'Search is slow.' };
let id: number;
beforeEach(async () => {
  await env.DB.exec('DROP TABLE IF EXISTS analysis_corrections; DROP TABLE IF EXISTS analyses; DROP TABLE IF EXISTS resolution_history; DROP TABLE IF EXISTS processing_jobs; DROP TABLE IF EXISTS feedback;');
  await env.DB.batch((first+second+correctionMigration).split(';').map(s=>s.trim()).filter(Boolean).map(s=>env.DB.prepare(s)));
  const response = await SELF.fetch('https://example.com/api/feedback',{method:'POST',headers:{...auth,'Content-Type':'application/json','Idempotency-Key':'job-test'},body:JSON.stringify({title:'Slow',description:'Search is slow.',source:'test'})});
  expect(response.status).toBe(202);
  id = (await response.json<{id:number}>()).id;
});
const job = () => env.DB.prepare('SELECT status,attempts,next_attempt_ms FROM processing_jobs WHERE feedback_id=?').bind(id).first<{status:string;attempts:number;next_attempt_ms:number}>();
it('persists validated versioned analysis once and preserves the original report', async () => {
  expect(await processOne(env,async()=>analysis,()=>1000)).toBe(true);
  expect(await processOne(env,async()=>{throw new Error('must not run');},()=>2000)).toBe(false);
  expect((await job())?.status).toBe('completed');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT sentiment FROM feedback WHERE id=?').bind(id).first('sentiment')).toBe(null);
  const rows = await (await SELF.fetch('https://example.com/api/triage',{headers:auth})).json<Array<{analysis_summary:string}>>();
  expect(rows[0].analysis_summary).toBe(analysis.summary);
});
it('backs off malformed output, terminates after five attempts, and permits explicit replay', async () => {
  let now=1000;
  for (let attempt=1;attempt<=5;attempt++) {
    await processOne(env,async()=>({sentiment:'invented'}),()=>now);
    const state=await job();
    expect(state?.attempts).toBe(attempt);
    expect(state?.status).toBe(attempt===5?'failed':'pending');
    expect(await processOne(env,async()=>analysis,()=>now)).toBe(false);
    now=state!.next_attempt_ms;
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(0);
  expect((await SELF.fetch(`https://example.com/api/feedback/${id}/replay`,{method:'POST',headers:auth})).status).toBe(202);
  expect((await SELF.fetch(`https://example.com/api/feedback/${id}/replay`,{method:'POST',headers:auth})).status).toBe(409);
  await processOne(env,async()=>analysis,()=>now);
  expect((await job())?.status).toBe('completed');
});
it('recovers an expired lease and fences a late result from the previous worker', async () => {
  let now=0;
  let release!: (value:unknown)=>void;
  let started!: ()=>void;
  const ready = new Promise<void>(resolve=>started=resolve);
  const old=processOne(env,()=>{started();return new Promise(resolve=>release=resolve);},()=>now);
  await ready;
  now=60001;
  await processOne(env,async()=>({...analysis,summary:'New lease result'}),()=>now);
  release({...analysis,summary:'Stale lease result'});
  await old;
  const rows=await env.DB.prepare('SELECT summary FROM analyses').all();
  expect(rows.results).toEqual([{summary:'New lease result'}]);
  expect((await job())?.attempts).toBe(2);
});
it('does not create duplicate analysis after completion is retried', async () => {
  await processOne(env,async()=>analysis,()=>0);
  // Simulate re-delivery of work whose analysis already committed.
  await env.DB.prepare("UPDATE processing_jobs SET status='pending' WHERE feedback_id=?").bind(id).run();
  await processOne(env,async()=>({...analysis,summary:'Duplicate'}),()=>1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT summary FROM analyses').first('summary')).toBe(analysis.summary);
  expect((await job())?.status).toBe('completed');
});
it('recovers a crash during the final attempt into terminal failure', async () => {
  await env.DB.prepare("UPDATE processing_jobs SET status='processing',attempts=5,lease_until=1,lease_token='dead'").run();
  expect(await processOne(env,async()=>analysis,()=>2)).toBe(false);
  expect((await job())?.status).toBe('failed');
});
it('times out stalled inference and propagates provider failures for retry', async () => {
  await expect(withTimeout(new Promise(()=>{}),1)).rejects.toThrow('Inference timeout');
  await processOne(env,async()=>{throw new Error('provider failed');},()=>0);
  expect((await job())?.status).toBe('pending');
  expect((await job())?.next_attempt_ms).toBe(60000);
});
it('fences results when the input fingerprint changes while processing', async () => {
  await processOne(env,async()=>{
    await env.DB.prepare("UPDATE feedback SET request_hash='new-version' WHERE id=?").bind(id).run();
    return analysis;
  },()=>0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(0);
  expect((await job())?.status).toBe('processing');
  // Expiration makes the revised input eligible without publishing stale output.
  await processOne(env,async()=>analysis,()=>60001);
  expect((await job())?.status).toBe('completed');
  expect(await env.DB.prepare('SELECT input_hash FROM analyses').first('input_hash')).toBe('new-version');
});
it('rolls back analysis if completion persistence fails', async () => {
  await env.DB.prepare("CREATE TRIGGER reject_completion BEFORE UPDATE ON processing_jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
  await processOne(env,async()=>analysis,()=>0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(0);
  expect((await job())?.status).toBe('pending');
  await env.DB.exec('DROP TRIGGER reject_completion');
  await processOne(env,async()=>analysis,()=>60000);
  expect((await job())?.status).toBe('completed');
});
it('grants only one live lease to concurrent processors', async () => {
  let calls=0;
  const analyze=async()=>{ calls++; return analysis; };
  const results=await Promise.all([processOne(env,analyze,()=>0),processOne(env,analyze,()=>0)]);
  expect(results.sort()).toEqual([false,true]);
  expect(calls).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(1);
});

it('rejects non-string sentiment values rather than coercing model output', () => {
  for (const sentiment of [['negative'], { toString: () => 'negative' }, null, 1]) {
    expect(() => validateAnalysis({ ...analysis, sentiment })).toThrow('Invalid analysis');
  }
  expect(validateAnalysis(analysis)).toEqual(analysis);
});


it('exposes only fixed processing error codes in triage, preserving stored history', async () => {
  for (const stored of [null, 'inference_timeout', 'invalid_analysis', 'persistence_failed', 'input_failed', 'inference_failed', 'attempt_limit', 'processing_failed', '', 'Bearer private-provider-token']) {
    await env.DB.prepare('UPDATE processing_jobs SET last_error=? WHERE feedback_id=?').bind(stored,id).run();
    const response = await SELF.fetch('https://example.com/api/triage',{headers:auth});
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const rows = await response.json<Array<{id:number;last_error:string|null}>>();
    const expected = stored === null ? null : ['processing_failed', '', 'Bearer private-provider-token'].includes(stored) ? 'unknown' : stored;
    expect(rows.find(row => row.id === id)?.last_error).toBe(expected);
    expect(await env.DB.prepare('SELECT last_error FROM processing_jobs WHERE feedback_id=?').bind(id).first('last_error')).toBe(stored);
  }
  expect((await SELF.fetch('https://example.com/api/triage')).status).toBe(401);
});

it('counts only unresolved latest failures and redacts unrecognized error text', async () => {
  await env.DB.prepare("UPDATE processing_jobs SET status='pending',last_error='inference_timeout' WHERE feedback_id=?").bind(id).run();
  for (const [offset,status,error] of [[1,'failed','invalid_analysis'],[2,'processing','persistence_failed'],[3,'completed','inference_timeout'],[4,'failed','secret provider payload']] as const) {
    await env.DB.prepare("INSERT INTO feedback(id,title,source) VALUES (?,'Fixture','test')").bind(200+offset).run();
    await env.DB.prepare('INSERT INTO processing_jobs(feedback_id,status,last_error) VALUES (?,?,?)').bind(200+offset,status,error).run();
  }
  const response = await SELF.fetch('https://example.com/api/processing/health',{headers:auth});
  const body = await response.text();
  expect(body).not.toContain('secret provider payload');
  expect(JSON.parse(body).last_failures).toEqual({input_failed:0,inference_failed:0,inference_timeout:1,invalid_analysis:1,persistence_failed:1,attempt_limit:0,unknown:1});
  await env.DB.prepare("UPDATE processing_jobs SET last_error=NULL WHERE feedback_id=?").bind(id).run();
  expect((await processingHealth(env.DB)).last_failures.inference_timeout).toBe(0);
});

it('reports ready work, backoff, expired leases and backlog age from one snapshot', async () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  await env.DB.prepare("UPDATE processing_jobs SET created_at='2026-10-25 11:55:00' WHERE feedback_id=?").bind(id).run();
  const states = [
    ['pending', 1, now+1000, null],
    ['processing', 2, 0, now+1000],
    ['processing', 3, 0, now],
    ['failed', 5, 0, null],
    ['completed', 1, 0, null],
  ];
  for (let i=0; i<states.length; i++) {
    await env.DB.prepare("INSERT INTO feedback(id,title,source) VALUES (?, 'Fixture', 'test')").bind(100+i).run();
    await env.DB.prepare("INSERT INTO processing_jobs(feedback_id,status,attempts,next_attempt_ms,lease_until,created_at) VALUES (?,?,?,?,?,'2026-10-25 11:59:00')").bind(100+i,...states[i]).run();
  }
  expect(await processingHealth(env.DB,now)).toEqual({pending:2,processing:2,completed:1,failed:1,
    last_failures:{input_failed:0,inference_failed:0,inference_timeout:0,invalid_analysis:0,persistence_failed:0,attempt_limit:0,unknown:0},ready_pending:1,delayed_pending:1,expired_leases:1,retried_jobs:3,oldest_active_age_seconds:300,inference_samples:0,average_inference_ms:null,max_inference_ms:null});
  const response = await SELF.fetch('https://example.com/api/processing/health',{headers:auth});
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect((await response.json<{failed:number}>()).failed).toBe(1);
  expect((await SELF.fetch('https://example.com/api/processing/health')).status).toBe(401);
});
it('distinguishes an empty backlog from zero age and clamps future timestamps', async () => {
  await env.DB.prepare("UPDATE processing_jobs SET created_at='2026-10-26 12:00:00'").run();
  expect((await processingHealth(env.DB,Date.parse('2026-10-25T12:00:00Z'))).oldest_active_age_seconds).toBe(0);
  await env.DB.prepare('DELETE FROM processing_jobs').run();
  expect(await processingHealth(env.DB)).toEqual({pending:0,processing:0,completed:0,failed:0,
    last_failures:{input_failed:0,inference_failed:0,inference_timeout:0,invalid_analysis:0,persistence_failed:0,attempt_limit:0,unknown:0},ready_pending:0,delayed_pending:0,expired_leases:0,retried_jobs:0,oldest_active_age_seconds:null,inference_samples:0,average_inference_ms:null,max_inference_ms:null});
});

const corrected = {sentiment:'positive',category:'usability',summary:'Reviewed by an analyst.',reason:'The report was misunderstood.'};
async function correctionBody(expected_revision=0) {
  const input_hash = await env.DB.prepare('SELECT request_hash FROM feedback WHERE id=?').bind(id).first<string>('request_hash');
  return {...corrected,input_hash,expected_revision};
}
const saveCorrection = (body: unknown) => SELF.fetch(`https://example.com/api/feedback/${id}/corrections`, {
  method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body),
});
it('preserves corrections and their history when machine analysis completes', async () => {
  const response = await saveCorrection(await correctionBody());
  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  await processOne(env,async()=>analysis,()=>1000);
  const rows = await (await SELF.fetch('https://example.com/api/triage',{headers:auth})).json<Array<Record<string,unknown>>>();
  expect(rows[0]).toMatchObject({analysis_summary:analysis.summary,correction_summary:corrected.summary,correction_revision:1});
  expect(await env.DB.prepare('SELECT sentiment FROM feedback WHERE id=?').bind(id).first('sentiment')).toBe(null);
  expect((await saveCorrection({...await correctionBody(1),summary:'Second review'})).status).toBe(201);
  const history = await (await SELF.fetch(`https://example.com/api/feedback/${id}/corrections`,{headers:auth})).json<Array<Record<string,unknown>>>();
  expect(history.map(row=>row.summary)).toEqual(['Second review',corrected.summary]);
});
it('permits only one correction for concurrent saves of the same revision', async () => {
  const body = await correctionBody();
  const responses = await Promise.all([saveCorrection(body),saveCorrection(body),saveCorrection(body)]);
  expect(responses.map(response=>response.status).sort()).toEqual([201,409,409]);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analysis_corrections').first('n')).toBe(1);
});
it('rejects stale input and retains old corrections without applying them to new input', async () => {
  const old = await correctionBody();
  expect((await saveCorrection(old)).status).toBe(201);
  await env.DB.prepare('UPDATE feedback SET request_hash=? WHERE id=?').bind('b'.repeat(64),id).run();
  expect((await saveCorrection({...old,expected_revision:1})).status).toBe(409);
  const rows = await (await SELF.fetch('https://example.com/api/triage',{headers:auth})).json<Array<Record<string,unknown>>>();
  expect(rows[0]).toMatchObject({correction_revision:0,correction_summary:null});
  expect((await saveCorrection(await correctionBody())).status).toBe(201);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analysis_corrections').first('n')).toBe(2);
});
it('validates correction fields, authentication and missing records', async () => {
  const body = await correctionBody();
  for (const change of [{reason:''},{reason:'x'.repeat(501)},{summary:'x'.repeat(1001)},
    {sentiment:['positive']},{expected_revision:-1},{expected_revision:1.5},{expected_revision:'0'},{input_hash:'invalid'}]) {
    expect((await saveCorrection({...body,...change})).status).toBe(400);
  }
  expect((await saveCorrection({...body,reason:'x'.repeat(17000)})).status).toBe(413);
  expect((await SELF.fetch(`https://example.com/api/feedback/${id}/corrections`)).status).toBe(401);
  expect((await SELF.fetch('https://example.com/api/feedback/99999/corrections',{headers:auth})).status).toBe(404);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analysis_corrections').first('n')).toBe(0);
});

it('records inference duration without job acquisition or input-read time', async () => {
  const times = [1000, 1400, 1475];
  await processOne(env,async()=>analysis,()=>times.shift() ?? 1475);
  expect(await env.DB.prepare('SELECT inference_ms FROM analyses').first('inference_ms')).toBe(75);
});
it('distinguishes safe failure codes and clears them after a successful retry', async () => {
  const code = () => env.DB.prepare('SELECT last_error FROM processing_jobs WHERE feedback_id=?').bind(id).first('last_error');
  await processOne(env,async()=>{throw new Error('private provider token');},()=>0);
  expect(await code()).toBe('inference_failed');
  await processOne(env,()=>withTimeout(new Promise(()=>{}),1),()=>60000);
  expect(await code()).toBe('inference_timeout');
  await processOne(env,async()=>({sentiment:'bad',summary:'private report'}),()=>180000);
  expect(await code()).toBe('invalid_analysis');
  await env.DB.prepare("CREATE TRIGGER reject_diagnostic_commit BEFORE UPDATE ON processing_jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'private storage details'); END").run();
  await processOne(env,async()=>analysis,()=>420000);
  expect(await code()).toBe('persistence_failed');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(0);
  await env.DB.exec('DROP TRIGGER reject_diagnostic_commit');
  await processOne(env,async()=>analysis,()=>900000);
  expect((await job())?.status).toBe('completed');
  expect(await code()).toBe(null);
});
it('classifies missing input versions without invoking inference', async () => {
  await env.DB.prepare('UPDATE feedback SET request_hash=NULL WHERE id=?').bind(id).run();
  let calls=0;
  await processOne(env,async()=>{calls++;return analysis;},()=>0);
  expect(calls).toBe(0);
  expect(await env.DB.prepare('SELECT last_error FROM processing_jobs WHERE feedback_id=?').bind(id).first('last_error')).toBe('input_failed');
});
it('classifies malformed provider envelopes and JSON without exposing raw output', async () => {
  for (const response of [null, {}, {response:'private malformed output'}, {response:'x'.repeat(8193)}]) {
    await env.DB.prepare("UPDATE processing_jobs SET status='pending',attempts=0,next_attempt_ms=0 WHERE feedback_id=?").bind(id).run();
    const bindings = {...env, AI:{run:async()=>response} as unknown as typeof env.AI};
    await processOne(bindings,undefined,()=>0);
    expect(await env.DB.prepare('SELECT last_error FROM processing_jobs WHERE feedback_id=?').bind(id).first('last_error')).toBe('invalid_analysis');
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first('n')).toBe(0);
});

it('reports inference latency only for current inputs and model/prompt versions', async () => {
  const hash = await env.DB.prepare('SELECT request_hash FROM feedback WHERE id=?').bind(id).first<string>('request_hash');
  const add = (feedbackId:number,inputHash:string,model:string,prompt:string,ms:number) => env.DB.prepare(
    "INSERT INTO analyses(feedback_id,input_hash,model_version,prompt_version,sentiment,category,summary,inference_ms) VALUES (?,?,?,?,'neutral','test','Fixture',?)"
  ).bind(feedbackId,inputHash,model,prompt,ms).run();
  await add(id,hash!,MODEL,PROMPT_VERSION,100);
  await add(id,hash!,MODEL,'old-prompt',9000);
  await add(id,hash!,'old-model',PROMPT_VERSION,9000);
  await add(id,'stale-input',MODEL,PROMPT_VERSION,9000);
  await env.DB.prepare("INSERT INTO feedback(id,title,source,request_hash) VALUES (999,'Fixture','test','second-input')").run();
  await add(999,'second-input',MODEL,PROMPT_VERSION,300);
  expect(await processingHealth(env.DB)).toMatchObject({pending:1,inference_samples:2,average_inference_ms:200,max_inference_ms:300});
  const response = await SELF.fetch('https://example.com/api/processing/health',{headers:auth});
  expect(await response.json()).toMatchObject({inference_samples:2,average_inference_ms:200,max_inference_ms:300});
  await env.DB.prepare("UPDATE feedback SET request_hash='changed' WHERE id=999").run();
  expect(await processingHealth(env.DB)).toMatchObject({inference_samples:1,average_inference_ms:100,max_inference_ms:100});
});

it('keeps unclassified feedback out of sentiment and uses current analyst decisions', async () => {
  const stats = async () => {
    const response = await SELF.fetch('https://example.com/api/stats',{headers:auth});
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    return response.json();
  };
  expect(await stats()).toMatchObject({total:1,avgSentiment:null,sentimentSamples:0,unclassified:1});
  await processOne(env,async()=>analysis,()=>1000);
  expect(await stats()).toMatchObject({avgSentiment:'2.0',sentimentSamples:1,unclassified:0});
  const firstCorrection = await SELF.fetch('https://example.com/api/feedback/'+id+'/corrections',{
    method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(await correctionBody())});
  expect(firstCorrection.status).toBe(201);
  expect(await stats()).toMatchObject({avgSentiment:'8.0',sentimentSamples:1});
  const secondCorrection = await SELF.fetch('https://example.com/api/feedback/'+id+'/corrections',{
    method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({...await correctionBody(1),sentiment:'neutral'})});
  expect(secondCorrection.status).toBe(201);
  expect(await stats()).toMatchObject({total:1,avgSentiment:'5.0',sentimentSamples:1});
  // Changing the input invalidates both old model output and old human review.
  await env.DB.prepare("UPDATE feedback SET request_hash='changed' WHERE id=?").bind(id).run();
  expect(await stats()).toMatchObject({avgSentiment:null,sentimentSamples:0,unclassified:1});
  await env.DB.prepare("INSERT INTO analyses(feedback_id,input_hash,model_version,prompt_version,sentiment,category,summary,inference_ms) VALUES (?,'changed',?,'old-prompt','positive','test','old',1)").bind(id,MODEL).run();
  expect(await stats()).toMatchObject({avgSentiment:null,sentimentSamples:0});
  // Legacy labels remain usable; unknown strings and pending inputs do not count.
  await env.DB.prepare("INSERT INTO feedback(title,source,sentiment) VALUES ('Legacy','test','positive'),('Unknown','test','mystery'),('Empty','test',NULL)").run();
  expect(await stats()).toMatchObject({total:4,avgSentiment:'8.0',sentimentSamples:1,unclassified:3});
  await env.DB.prepare('DELETE FROM analysis_corrections').run();
  await env.DB.prepare('DELETE FROM analyses').run();
  await env.DB.prepare('DELETE FROM processing_jobs').run();
  await env.DB.prepare('DELETE FROM feedback').run();
  expect(await stats()).toMatchObject({total:0,avgSentiment:null,sentimentSamples:0,unclassified:0});
});

it('groups current classifications without assigning an arbitrary sentiment to mixed issues', async () => {
  const top = async () => {
    const response = await SELF.fetch('https://example.com/api/top-issues',{headers:auth});
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    return response.json<Array<Record<string,unknown>>>();
  };
  expect((await top())[0]).toMatchObject({title:'Slow',count:1,sentiment:null,unclassified_count:1});
  await processOne(env,async()=>analysis,()=>1000);
  expect((await top())[0]).toMatchObject({sentiment:'negative',negative_count:1,unclassified_count:0});
  await env.DB.prepare("INSERT INTO feedback(title,source,sentiment) VALUES ('Slow','test','positive'),('Slow','test','negative')").run();
  expect((await top())[0]).toMatchObject({count:3,sentiment:null,positive_count:1,negative_count:2});
  for (const [revision,sentiment] of [[0,'positive'],[1,'neutral']] as const) {
    const response = await SELF.fetch('https://example.com/api/feedback/'+id+'/corrections',{
      method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({...await correctionBody(revision),sentiment})});
    expect(response.status).toBe(201);
  }
  expect((await top())[0]).toMatchObject({count:3,sentiment:null,positive_count:1,neutral_count:1,negative_count:1,unclassified_count:0});
  await env.DB.prepare("UPDATE feedback SET request_hash='changed' WHERE id=?").bind(id).run();
  expect((await top())[0]).toMatchObject({count:3,neutral_count:0,unclassified_count:1});
  await env.DB.prepare("UPDATE feedback SET resolved_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  expect((await top())[0]).toMatchObject({count:2,positive_count:1,negative_count:1,unclassified_count:0});
});

it('orders equal-sized issue groups deterministically and limits the result', async () => {
  for (const title of ['Z','Y','X','C','B','A']) {
    await env.DB.prepare("INSERT INTO feedback(title,source,sentiment) VALUES (?,'test','neutral')").bind(title).run();
  }
  const response = await SELF.fetch('https://example.com/api/top-issues',{headers:auth});
  const rows = await response.json<Array<{title:string}>>();
  expect(rows.map(row=>row.title)).toEqual(['A','B','C','Slow','X']);
});


it('uses current classifications in recent reports, details and reporter history', async () => {
  await env.DB.prepare("UPDATE feedback SET user_email='views@example.test' WHERE id=?").bind(id).run();
  const check = async (sentiment: string | null, category: string | null) => {
    const recent = await (await SELF.fetch('https://example.com/api/recent',{headers:auth})).json<Array<Record<string,unknown>>>();
    expect(recent.find(row=>row.id===id)).toMatchObject({sentiment});
    const detail = await (await SELF.fetch(`https://example.com/api/feedback/${id}`,{headers:auth})).json<{sentiment:unknown;category:unknown;userHistory:Array<Record<string,unknown>>}>();
    expect(detail).toMatchObject({sentiment,category});
    expect(detail.userHistory.find(row=>row.id===id)).toMatchObject({sentiment});
  };
  await check(null,null);
  await processOne(env,async()=>analysis);
  await check('negative','performance');
  expect((await saveCorrection(await correctionBody())).status).toBe(201);
  await check('positive','usability');
  expect((await saveCorrection({...await correctionBody(1),sentiment:'neutral',category:'other'})).status).toBe(201);
  await check('neutral','other');
  await env.DB.prepare("UPDATE feedback SET request_hash='changed' WHERE id=?").bind(id).run();
  await check(null,null);
  await env.DB.prepare("UPDATE feedback SET request_hash=NULL,sentiment='positive',category='legacy' WHERE id=?").bind(id).run();
  await check('positive','legacy');
});

it('invalidates insight snapshots when current model labels or corrections change', async () => {
  const inputs: Array<Array<Record<string,unknown>>> = [];
  const cache = new Map<string,string>();
  const bindings = {...env,
    CACHE: {get:async(key:string)=>cache.get(key) ?? null,put:async(key:string,value:string)=>{cache.set(key,value);}} as unknown as KVNamespace,
    AI: {run:async(_model:string,options:{messages:{content:string}[]})=>{
      inputs.push(JSON.parse(options.messages[1].content.split('\n\n')[1]));
      return {response:'Controlled result '+inputs.length};
    }} as unknown as Ai};
  const insights = async () => {
    const response = await worker.fetch(new Request('https://example.com/api/ai-insights',{headers:auth}),bindings);
    expect(response.status).toBe(200);
    return response.json();
  };
  const pending = await insights();
  expect(await insights()).toEqual(pending);
  expect(inputs).toHaveLength(1);
  await processOne(env,async()=>analysis);
  await insights();
  expect(inputs).toHaveLength(2);
  expect(inputs[1][0]).toMatchObject({id,sentiment:'negative',category:'performance'});
  expect((await saveCorrection(await correctionBody())).status).toBe(201);
  const reviewed = await insights();
  expect(inputs).toHaveLength(3);
  expect(inputs[2][0]).toMatchObject({id,sentiment:'positive',category:'usability'});
  expect(await insights()).toEqual(reviewed);
  expect(inputs).toHaveLength(3);
  await env.DB.prepare("UPDATE feedback SET request_hash='changed' WHERE id=?").bind(id).run();
  // Stale labels disappear, returning to the exact cached pending snapshot.
  expect(await insights()).toEqual(pending);
  expect(inputs).toHaveLength(3);
  expect(inputs[0][0]).toMatchObject({id,sentiment:null,category:null});
  expect(await env.DB.prepare('SELECT sentiment FROM feedback WHERE id=?').bind(id).first('sentiment')).toBe(null);
});

it('suggests only candidate IDs without changing report or job state', async () => {
  await env.DB.prepare("INSERT INTO feedback(id,title,description,source,request_hash) VALUES (900,'Search delay','Results arrive late','test','candidate-version')").run();
  let calls = 0;
  const bindings = {...env, AI:{run:async()=>{calls++;return {response:JSON.stringify({duplicate_ids:[900]})};}} as unknown as typeof env.AI};
  const request = () => new Request(`https://example.com/api/feedback/${id}/duplicates`,{method:'POST',headers:auth});
  const response = await worker.fetch(request(),bindings);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json<{suggestions:Array<{id:number}>;candidate_count:number}>();
  expect(body.suggestions.map(row=>row.id)).toEqual([900]);
  expect(body.candidate_count).toBe(1);
  expect(calls).toBe(1);
  expect((await job())?.status).toBe('pending');
  expect(await env.DB.prepare('SELECT resolved_at FROM feedback WHERE id=?').bind(id).first('resolved_at')).toBe(null);
});

it('rejects fabricated, repeated and malformed duplicate suggestions without leaking output', async () => {
  await env.DB.prepare("INSERT INTO feedback(id,title,description,source,request_hash) VALUES (900,'Other','Body','test','v1')").run();
  for (const value of [null, {}, {response:'private provider output'}, {response:'x'.repeat(4097)},
    ...[[901],[id],[900,900],['900'],[900.5],null].map(duplicate_ids=>({response:JSON.stringify({duplicate_ids})}))]) {
    const bindings = {...env, AI:{run:async()=>value} as unknown as typeof env.AI};
    const response = await worker.fetch(new Request(`https://example.com/api/feedback/${id}/duplicates`,{method:'POST',headers:auth}),bindings);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private provider output');
  }
  const bindings = {...env, AI:{run:async()=>{throw new Error('private provider token');}} as unknown as typeof env.AI};
  const response = await worker.fetch(new Request(`https://example.com/api/feedback/${id}/duplicates`,{method:'POST',headers:auth}),bindings);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private provider token');
});

it('bounds duplicate comparison inputs and rejects a changed snapshot', async () => {
  for(let n=100;n<125;n++) await env.DB.prepare('INSERT INTO feedback(id,title,description,source,request_hash) VALUES (?,?,?,?,?)').bind(n,'Title','x'.repeat(2000),'test','v'+n).run();
  const tooMany = {...env, AI:{run:async()=>({response:JSON.stringify({duplicate_ids:[124,123,122,121,120,119]})})} as unknown as typeof env.AI};
  expect((await worker.fetch(new Request(`https://example.com/api/feedback/${id}/duplicates`,{method:'POST',headers:auth}),tooMany)).status).toBe(502);
  let observed: {candidates:Array<{id:number;description:string}>} | undefined;
  const bindings = {...env, AI:{run:async(_model:unknown,args:{messages:Array<{content:string}>})=>{
    observed=JSON.parse(args.messages[1].content);
    await env.DB.prepare("UPDATE feedback SET request_hash='changed' WHERE id=124").run();
    return {response:JSON.stringify({duplicate_ids:[124]})};
  }} as unknown as typeof env.AI};
  const response = await worker.fetch(new Request(`https://example.com/api/feedback/${id}/duplicates`,{method:'POST',headers:auth}),bindings);
  expect(observed?.candidates.map(row=>row.id)).toEqual(Array.from({length:20},(_,n)=>124-n));
  expect(observed?.candidates.every(row=>row.description.length===1000)).toBe(true);
  expect(response.status).toBe(409);
});

it('skips inference for no candidates and rejects unauthenticated or unversioned requests', async () => {
  let calls=0;
  const bindings = {...env, AI:{run:async()=>{calls++;throw new Error('must not call');}} as unknown as typeof env.AI};
  const call = (path:string,headers:Record<string,string>=auth) => worker.fetch(new Request('https://example.com'+path,{method:'POST',headers}),bindings);
  const response = await call(`/api/feedback/${id}/duplicates`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({suggestions:[],candidate_count:0});
  expect((await call(`/api/feedback/${id}/duplicates`,{})).status).toBe(401);
  expect((await call('/api/feedback/999999/duplicates')).status).toBe(404);
  expect((await call('/api/feedback/9007199254740992/duplicates')).status).toBe(400);
  await env.DB.prepare('UPDATE feedback SET request_hash=NULL WHERE id=?').bind(id).run();
  expect((await call(`/api/feedback/${id}/duplicates`)).status).toBe(409);
  expect(calls).toBe(0);
});
