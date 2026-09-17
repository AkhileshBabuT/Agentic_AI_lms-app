CREATE TABLE IF NOT EXISTS answer_runs (
  id UUID PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer_status TEXT NOT NULL CHECK(answer_status IN ('answered','partial','insufficient_evidence')),
  pipeline_version TEXT NOT NULL,
  evidence_manifest JSONB NOT NULL,
  generation_metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS answer_citations (
  answer_run_id UUID NOT NULL REFERENCES answer_runs(id) ON DELETE CASCADE,
  citation_number INTEGER NOT NULL CHECK(citation_number > 0),
  evidence_id TEXT NOT NULL,
  chunk_id UUID NOT NULL REFERENCES material_chunks(id),
  material_id INTEGER NOT NULL REFERENCES course_materials(id),
  version_id UUID NOT NULL REFERENCES material_versions(id),
  run_id UUID NOT NULL REFERENCES material_index_runs(id),
  excerpt TEXT NOT NULL,
  locator JSONB NOT NULL,
  material_name TEXT NOT NULL,
  PRIMARY KEY(answer_run_id,citation_number),
  UNIQUE(answer_run_id,evidence_id)
);
CREATE INDEX IF NOT EXISTS answer_citations_chunk_idx ON answer_citations(chunk_id);
