CREATE TABLE analysis_corrections (
  feedback_id INTEGER NOT NULL REFERENCES feedback(id),
  input_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  sentiment TEXT NOT NULL CHECK(sentiment IN ('positive','neutral','negative')),
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(feedback_id, input_hash, revision)
);
