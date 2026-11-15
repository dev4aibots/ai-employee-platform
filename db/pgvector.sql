-- ===========================================================================
-- ai-employee-platform :: optional pgvector upgrade (production Postgres)
--
-- The portable schema stores embeddings as double precision[] so the whole
-- test suite runs on in-process PostgreSQL with no extensions. On a real
-- Postgres 15+ with pgvector available, apply this file once to switch to a
-- native vector column and an HNSW index.
--
-- After this migration, src/retrieval/hybrid.ts keeps working unchanged: it
-- casts the parameter to double precision[] and the vector column compares
-- through the array cast in the SQL function. For maximum index usage switch
-- the ORDER BY to `d.embedding <=> $2::vector` as noted below.
-- ===========================================================================

create extension if not exists vector;

alter table documents
  add column if not exists embedding_vec vector(1536);

update documents
set embedding_vec = embedding::text::vector
where embedding is not null and embedding_vec is null;

-- Approximate nearest neighbour index. HNSW is preferred over IVFFlat for
-- read-heavy workloads because it does not need a training pass and keeps its
-- recall as rows are inserted.
create index if not exists documents_embedding_hnsw
  on documents using hnsw (embedding_vec vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Optional: drop the portable column once the application reads embedding_vec.
-- alter table documents drop column embedding;

-- Query shape to use once the index exists (replace the cosine_similarity arm
-- in the `dense` CTE with this ORDER BY):
--
--   order by d.embedding_vec <=> $2::vector
