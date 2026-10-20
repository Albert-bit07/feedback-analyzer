CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,
  user_email TEXT,
  user_id TEXT,
  sentiment TEXT,
  category TEXT,
  ai_themes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  priority TEXT DEFAULT 'medium',
  upvotes INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_user_email ON feedback(user_email);
CREATE INDEX IF NOT EXISTS idx_created_at ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_resolved_at ON feedback(resolved_at);


ALTER TABLE feedback ADD COLUMN idempotency_key TEXT;
ALTER TABLE feedback ADD COLUMN request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_idempotency ON feedback(idempotency_key);
CREATE TABLE processing_jobs (
  feedback_id INTEGER PRIMARY KEY REFERENCES feedback(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE resolution_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL REFERENCES feedback(id),
  status TEXT NOT NULL CHECK(status IN ('resolved','open')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
