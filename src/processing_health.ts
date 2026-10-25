export interface ProcessingHealth {
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
  const result = await db.prepare(`WITH clock(now_ms) AS (VALUES (?))
    SELECT
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
    FROM processing_jobs CROSS JOIN clock`).bind(now).first<ProcessingHealth>();
  if (!result) throw new Error('Processing health query returned no aggregate');
  return result;
}
