import { MODEL, PROMPT_VERSION } from './processing.ts';
import { processingHealth } from './processing_health.ts';
import type { Env } from './index';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('content-type');
  if (!request.body) throw new Error('json');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('json');
  return parsed;
}

function field(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(name);
  return value.trim();
}

export async function workflow(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/feedback' && request.method === 'POST') {
    let title: string, description: string, source: string;
    const key = request.headers.get('Idempotency-Key') ?? '';
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return json({ error: 'Supply an Idempotency-Key (1–128 ASCII letters, digits, . _ : -)' }, 400);
    try {
      const body = await readBody(request);
      title = field(body, 'title', 200);
      description = field(body, 'description', 8000);
      source = field(body, 'source', 80);
    } catch (error) {
      return json({ error: 'Expected JSON with title (1–200), description (1–8000), and source (1–80 characters)' }, error instanceof Error && error.message === 'size' ? 413 : 400);
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ title, description, source })))), b => b.toString(16).padStart(2, '0')).join('');
    // D1 batch is transactional: a submission cannot commit without its processing intent.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO feedback (title, description, source, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING').bind(title, description, source, key, hash),
      env.DB.prepare('INSERT INTO processing_jobs (feedback_id) SELECT id FROM feedback WHERE idempotency_key = ? AND request_hash = ? ON CONFLICT(feedback_id) DO NOTHING').bind(key, hash),
    ]);
    const row = await env.DB.prepare('SELECT id, request_hash FROM feedback WHERE idempotency_key = ?').bind(key).first<{ id: number; request_hash: string }>();
    if (!row || row.request_hash !== hash) return json({ error: 'Idempotency key already used for different feedback' }, 409);
    return json({ id: row.id, processing: 'accepted', location: `/api/feedback/${row.id}` }, 202);
  }
  if (path === '/api/triage' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT f.id, f.title, f.description, f.source, f.created_at, f.resolved_at,
      j.status AS processing_status, j.attempts, j.last_error, j.next_attempt_ms, a.summary AS analysis_summary, a.sentiment AS analysis_sentiment, a.inference_ms
      FROM feedback f LEFT JOIN processing_jobs j ON j.feedback_id = f.id
      LEFT JOIN analyses a ON a.feedback_id=f.id AND a.input_hash=f.request_hash AND a.model_version=? AND a.prompt_version=?
      ORDER BY f.id DESC LIMIT 100`).bind(MODEL,PROMPT_VERSION).all();
    return json(rows.results);
  }
  const replay = path.match(/^\/api\/feedback\/([1-9][0-9]*)\/replay$/);
  if (replay && request.method === 'POST') {
    const id = Number(replay[1]);
    if (!Number.isSafeInteger(id)) return json({ error: 'Invalid feedback ID' }, 400);
    const result = await env.DB.prepare("UPDATE processing_jobs SET status='pending',attempts=0,next_attempt_ms=0,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE feedback_id=? AND status='failed' RETURNING feedback_id").bind(id).first();
    return result ? json({ id, processing: 'pending' }, 202) : json({ error: 'No failed job to replay' }, 409);
  }
  if (path === '/api/processing/health' && request.method === 'GET') {
    return json(await processingHealth(env.DB));
  }
  if (path === '/api/processing' && request.method === 'GET') {
    const jobs = await env.DB.prepare("SELECT status,COUNT(*) AS count,SUM(attempts) AS attempts,MIN(created_at) AS oldest_created_at FROM processing_jobs GROUP BY status").all();
    return json(jobs.results);
  }
  const match = path.match(/^\/api\/feedback\/([1-9][0-9]*)\/status$/);
  if (match && request.method === 'POST') {
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id)) return json({ error: 'Invalid feedback ID' }, 400);
    let status: string;
    try { status = field(await readBody(request), 'status', 8); } catch { return json({ error: 'Expected status: open or resolved' }, 400); }
    if (status !== 'open' && status !== 'resolved') return json({ error: 'Expected status: open or resolved' }, 400);
    if (!await env.DB.prepare('SELECT id FROM feedback WHERE id = ?').bind(id).first()) return json({ error: 'Feedback not found' }, 404);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO resolution_history (feedback_id, status) SELECT id, ? FROM feedback WHERE id = ? AND ((? = 'resolved' AND resolved_at IS NULL) OR (? = 'open' AND resolved_at IS NOT NULL))`).bind(status, id, status, status),
      env.DB.prepare(`UPDATE feedback SET resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, CURRENT_TIMESTAMP) ELSE NULL END WHERE id = ?`).bind(status, id),
    ]);
    return json({ id, status });
  }
  return null;
}
