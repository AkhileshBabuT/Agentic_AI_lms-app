-- Additive: legacy indexes remain intact until the new published pointer is ready.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS published_run_id UUID;
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS ingestion_status TEXT NOT NULL DEFAULT 'unindexed';
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS ingestion_error TEXT;
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS ingestion_warning TEXT;
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'published';
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS material_versions (
 id UUID PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES course_materials(id),
 object_name TEXT NOT NULL, object_generation TEXT NOT NULL CHECK(object_generation ~ '^[0-9]+$'), sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 mime_type TEXT NOT NULL, byte_count BIGINT NOT NULL CHECK(byte_count>0), original_filename TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(material_id, object_name, object_generation)
);
CREATE TABLE IF NOT EXISTS material_index_runs (
 id UUID PRIMARY KEY, version_id UUID NOT NULL REFERENCES material_versions(id),
 embedding_space_id TEXT NOT NULL, pipeline_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','published','needs_review','failed')),
 metadata JSONB NOT NULL DEFAULT '{}', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ, UNIQUE(version_id, embedding_space_id, pipeline_version)
);
CREATE TABLE IF NOT EXISTS material_pages (
 run_id UUID NOT NULL REFERENCES material_index_runs(id), ordinal INTEGER NOT NULL CHECK(ordinal>0),
 text TEXT NOT NULL, locator JSONB NOT NULL, PRIMARY KEY(run_id, ordinal)
);
CREATE TABLE IF NOT EXISTS material_chunks (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES material_index_runs(id),
 material_id INTEGER NOT NULL REFERENCES course_materials(id), course_id INTEGER NOT NULL REFERENCES courses(id),
 text TEXT NOT NULL CHECK(length(text)>0), locator JSONB NOT NULL CHECK(jsonb_typeof(locator)='object'), token_count INTEGER NOT NULL CHECK(token_count>0),
 search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX IF NOT EXISTS material_chunks_search_idx ON material_chunks USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS material_chunks_course_run_idx ON material_chunks(course_id, run_id);
CREATE TABLE IF NOT EXISTS chunk_embeddings (
 chunk_id UUID PRIMARY KEY REFERENCES material_chunks(id), embedding_space_id TEXT NOT NULL,
 embedding vector(768) NOT NULL
);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
 id UUID PRIMARY KEY, run_id UUID NOT NULL UNIQUE REFERENCES material_index_runs(id),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','complete','needs_review','failed')), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5), available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_owner TEXT, lease_token UUID, lease_until TIMESTAMPTZ, error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_idx ON ingestion_jobs(status, available_at, lease_until);
CREATE TABLE IF NOT EXISTS material_upload_intents (
 id UUID PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES course_materials(id), version_id UUID NOT NULL,
 object_name TEXT NOT NULL UNIQUE, expected_sha256 TEXT NOT NULL CHECK(expected_sha256 ~ '^[a-f0-9]{64}$'), mime_type TEXT NOT NULL,
 byte_count BIGINT NOT NULL CHECK(byte_count>0), original_filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reconcile','complete','failed')),
 error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='course_materials_ingestion_status_check' AND conrelid='course_materials'::regclass) THEN
  ALTER TABLE course_materials ADD CONSTRAINT course_materials_ingestion_status_check
   CHECK(ingestion_status IN ('unindexed','uploading','upload_failed','queued','processing','ready','needs_review','failed','deleted'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='course_materials_visibility_check' AND conrelid='course_materials'::regclass) THEN
  ALTER TABLE course_materials ADD CONSTRAINT course_materials_visibility_check CHECK(visibility IN ('published','draft','deleted'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_materials_published_run_fk' AND conrelid='course_materials'::regclass) THEN
  ALTER TABLE course_materials ADD CONSTRAINT course_materials_published_run_fk
   FOREIGN KEY(published_run_id) REFERENCES material_index_runs(id);
 END IF;
END $$;
