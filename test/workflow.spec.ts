import correctionMigration from '../migrations/0003_corrections.sql?raw';
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import migration from '../migrations/0001_ingestion.sql?raw';
import processingMigration from '../migrations/0002_processing.sql?raw';
import worker from '../src/index';
const auth = { Authorization: 'Basic ' + btoa('analyst:test-only-password') };
const payload = { title: 'Slow API', description: 'Requests take too long.', source: 'manual' };
const submit = (key = 'request-1', body: unknown = payload) => SELF.fetch('https://example.com/api/feedback', {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
});
const status = (id: number, value: string) => SELF.fetch(`https://example.com/api/feedback/${id}/status`, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({status: value}),
});
beforeEach(async () => {
  await env.DB.exec('DROP TABLE IF EXISTS analysis_corrections; DROP TABLE IF EXISTS analyses; DROP TABLE IF EXISTS resolution_history; DROP TABLE IF EXISTS processing_jobs; DROP TABLE IF EXISTS feedback;');
  await env.DB.batch((migration+processingMigration+correctionMigration).split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)));
});
describe('authenticated ingestion and triage', () => {
  it('fails closed without configuration or valid credentials', async () => {
    for (const path of ['/', '/triage', '/api/triage', '/api/feedback/1', '/api/ai-insights']) {
      expect((await SELF.fetch('https://example.com'+path)).status).toBe(401);
      expect((await SELF.fetch('https://example.com'+path, { headers: { Authorization: 'Basic !!!' } })).status).toBe(401);
    }
    const response = await worker.fetch(new Request('https://example.com'), { ...env, DASHBOARD_PASSWORD: undefined });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects cross-site authenticated mutations', async () => {
    const response = await SELF.fetch('https://example.com/api/feedback', { method: 'POST', headers: { ...auth, Origin:'https://hostile.test' } });
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('deduplicates concurrent retries and persists one processing intent', async () => {
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map(r => r.status)).toEqual([202,202]);
    const rows = await Promise.all(responses.map(r => r.json<{id:number}>()));
    expect(rows[0].id).toBe(rows[1].id);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM feedback').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM processing_jobs').first('n')).toBe(1);
    expect((await submit('request-1', {...payload,title:'Different'})).status).toBe(409);
  });
  it('rolls back feedback when job creation fails', async () => {
    await env.DB.exec('DROP TABLE processing_jobs');
    expect((await submit()).status).toBe(500);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM feedback').first('n')).toBe(0);
  });
  it('validates input and enforces streamed body limits', async () => {
    for (const body of [null, [], {}, {...payload,title:''}, {...payload,description:'x'.repeat(8001)}]) expect((await submit('invalid',body)).status).toBe(400);
    expect((await submit('',payload)).status).toBe(400);
    expect((await submit('large',{...payload,description:'x'.repeat(17000)})).status).toBe(413);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM feedback').first('n')).toBe(0);
  });
  it('resolves and reopens with immediate summary freshness and idempotent history', async () => {
    const {id} = await (await submit()).json<{id:number}>();
    const stats = async () => (await SELF.fetch('https://example.com/api/stats',{headers:auth})).json<{unresolved:number}>();
    expect((await stats()).unresolved).toBe(1);
    expect((await status(id,'resolved')).status).toBe(200);
    expect((await status(id,'resolved')).status).toBe(200);
    expect((await stats()).unresolved).toBe(0);
    expect((await status(id,'open')).status).toBe(200);
    expect((await stats()).unresolved).toBe(1);
    const history = await env.DB.prepare('SELECT status FROM resolution_history ORDER BY id').all();
    expect(history.results).toEqual([{status:'resolved'},{status:'open'}]);
    const response = await SELF.fetch('https://example.com/api/triage',{headers:auth});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json<Array<{processing_status:string}>>())[0].processing_status).toBe('pending');
    expect((await status(999,'open')).status).toBe(404);
    expect((await status(id,'invalid')).status).toBe(400);
  });
});
