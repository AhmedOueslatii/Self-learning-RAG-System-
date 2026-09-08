ALTER TABLE documents ADD COLUMN doc_type TEXT DEFAULT 'raw';
ALTER TABLE documents ADD COLUMN reflection_score REAL DEFAULT 0;
ALTER TABLE documents ADD COLUMN parent_id TEXT;
