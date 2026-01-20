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

INSERT INTO feedback (title, description, source, user_email, sentiment, category, priority, created_at) VALUES
('API Response Time Slow', 'Workers API takes 5+ seconds to respond', 'Discord', 'dev@company.com', 'negative', 'performance', 'high', datetime('now', '-45 days')),
('Documentation Unclear on D1 Setup', 'Cannot find clear instructions for D1 migrations', 'Support Ticket', 'pm@startup.io', 'neutral', 'docs', 'medium', datetime('now', '-38 days')),
('Workers AI Rate Limiting', 'Hit rate limits with Workers AI too quickly', 'GitHub', 'eng@tech.com', 'negative', 'ai', 'high', datetime('now', '-31 days')),
('Dashboard UI Confusing', 'Hard to find deployment settings', 'Twitter', 'user1@email.com', 'negative', 'ux', 'medium', datetime('now', '-2 days')),
('Cannot deploy to Workers', 'Deployment fails with cryptic error', 'Discord', 'dev@company.com', 'negative', 'deployment', 'high', datetime('now', '-5 minutes')),
('KV storage quota exceeded', 'Need more storage for KV', 'Support Ticket', 'dev@company.com', 'neutral', 'storage', 'medium', datetime('now', '-12 minutes')),
('Great new AI feature!', 'Love the new AI models', 'Twitter', 'fan@email.com', 'positive', 'ai', 'low', datetime('now', '-1 hour')),
('Wrangler CLI crashes on Windows', 'CLI crashes when running deploy command', 'GitHub', 'eng@tech.com', 'negative', 'tooling', 'high', datetime('now', '-45 days')),
('R2 CORS configuration unclear', 'Cannot figure out CORS setup for R2', 'Support Ticket', 'pm@startup.io', 'neutral', 'docs', 'medium', datetime('now', '-38 days')),
('API performance degraded', 'API is slower than usual', 'Discord', 'dev@company.com', 'negative', 'performance', 'high', datetime('now', '-3 days')),
('Love the new features!', 'Great updates this month', 'Twitter', 'happy@user.com', 'positive', 'general', 'low', datetime('now', '-1 day')),
('Database migration failed', 'D1 migration script not working', 'Support Ticket', 'pm@startup.io', 'negative', 'database', 'medium', datetime('now', '-2 hours')),
('Workers AI is slow', 'AI inference takes too long', 'GitHub', 'eng@tech.com', 'negative', 'ai', 'medium', datetime('now', '-31 days')); 
