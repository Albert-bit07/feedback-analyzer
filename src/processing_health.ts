import { MODEL, PROMPT_VERSION } from './processing.ts';

const FAILURE_CODES = ['input_failed', 'inference_failed', 'inference_timeout', 'invalid_analysis', 'persistence_failed', 'attempt_limit', 'unknown'] as const;
type FailureCounts = Record<typeof FAILURE_CODES[number], number>;

export interface ProcessingHealth {
  last_failures: FailureCounts;
  inference_samples: number;
  average_inference_ms: number | null;
  max_inference_ms: number | null;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  ready_pending: number;
  delayed_pending: number;
  expired_leases: number;
  retried_jobs: number;
  oldest_active_age_seconds: number | null;
}

export async function processingHealth(db: D1Database, now = Date.now()): Promise<ProcessingHealth> {
  // One statement gives a consistent snapshot across all counters. Failed jobs
  // require explicit replay and are excluded from the active backlog age.
  // Only fixed labels enter SQL or the response; old/raw provider messages map to unknown.
  const knownCodes = FAILURE_CODES.filter(code => code !== 'unknown').map(code => `'${code}'`).join(',');
  const failureCounts = FAILURE_CODES.map(code => {
    const matches = code === 'unknown'
      ? `last_error IS NOT NULL AND last_error NOT IN (${knownCodes})`
      : `last_error='${code}'`;
    return `'${code}', COUNT(CASE WHEN status IN ('pending','processing','failed') AND ${matches} THEN 1 END)`;
  }).join(',');
  const result = await db.prepare(`WITH clock(now_ms) AS (VALUES (?)), latency AS (
      SELECT COUNT(*) AS inference_samples, AVG(a.inference_ms) AS average_inference_ms,
        MAX(a.inference_ms) AS max_inference_ms
      FROM analyses a JOIN feedback f ON f.id=a.feedback_id AND f.request_hash=a.input_hash
      WHERE a.model_version=? AND a.prompt_version=?
    ), jobs AS (SELECT
      json_object(${failureCounts}) AS failures_json,
      COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status='processing' THEN 1 END) AS processing,
      COUNT(CASE WHEN status='completed' THEN 1 END) AS completed,
      COUNT(CASE WHEN status='failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN status='pending' AND next_attempt_ms<=now_ms THEN 1 END) AS ready_pending,
      COUNT(CASE WHEN status='pending' AND next_attempt_ms>now_ms THEN 1 END) AS delayed_pending,
      COUNT(CASE WHEN status='processing' AND lease_until<=now_ms THEN 1 END) AS expired_leases,
      COUNT(CASE WHEN attempts>1 THEN 1 END) AS retried_jobs,
      MAX(CASE WHEN status IN ('pending','processing')
        THEN MAX(0, CAST(now_ms/1000 AS INTEGER)-CAST(strftime('%s',created_at) AS INTEGER)) END) AS oldest_active_age_seconds
    FROM processing_jobs CROSS JOIN clock)
    SELECT * FROM jobs CROSS JOIN latency`).bind(now,MODEL,PROMPT_VERSION).first<Omit<ProcessingHealth, 'last_failures'> & {failures_json: string}>();
  if (!result) throw new Error('Processing health query returned no aggregate');
  const { failures_json, ...health } = result;
  return { ...health, last_failures: JSON.parse(failures_json) as FailureCounts };
}
