ALTER TABLE processing_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE processing_jobs ADD COLUMN lease_until INTEGER;
ALTER TABLE processing_jobs ADD COLUMN next_attempt_ms INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_jobs_due ON processing_jobs(status, next_attempt_ms);
CREATE TABLE analyses (
  feedback_id INTEGER NOT NULL REFERENCES feedback(id),
  input_hash TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK(sentiment IN ('positive','neutral','negative')),
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  inference_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(feedback_id, input_hash, model_version, prompt_version)
);
