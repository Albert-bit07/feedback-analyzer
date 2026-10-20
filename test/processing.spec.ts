import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import first from '../migrations/0001_ingestion.sql?raw';
import second from '../migrations/0002_processing.sql?raw';
import { processOne, withTimeout } from '../src/processing';
const auth = { Authorization: 'Basic '+btoa('analyst:test-only-password') };
const analysis = { sentiment:'negative',category:'performance',summary:'Search is slow.' };
let id: number;
beforeEach(async () => {
  await env.DB.exec('DROP TABLE IF EXISTS analyses; DROP TABLE IF EXISTS resolution_history; DROP TABLE IF EXISTS processing_jobs; DROP TABLE IF EXISTS feedback;');
  await env.DB.batch((first+second).split(';').map(s=>s.trim()).filter(Boolean).map(s=>env.DB.prepare(s)));
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
