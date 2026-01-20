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