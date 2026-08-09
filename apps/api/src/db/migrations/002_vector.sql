-- Векторный поиск. Применяется ТОЛЬКО если pgvector доступен — см. migrate.ts.
-- Управляемый Postgres в РФ-регионе не всегда его предлагает, а падать
-- из-за отсутствия расширения на старте нельзя: retrieval деградирует
-- до структурного поиска, а не ломается.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE entity ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE fact   ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE INDEX IF NOT EXISTS entity_embedding_idx ON entity
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS fact_embedding_idx ON fact
  USING hnsw (embedding vector_cosine_ops);
