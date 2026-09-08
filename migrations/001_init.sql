CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,
  date_created TEXT DEFAULT (datetime('now'))
);
