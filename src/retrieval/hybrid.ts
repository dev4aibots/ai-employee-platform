/**
 * Hybrid retrieval: lexical (BM25-ish via ts_rank) fused with dense cosine
 * similarity using Reciprocal Rank Fusion.
 *
 * Why hybrid instead of pure vectors: support questions contain exact tokens —
 * part numbers, invoice ids, error codes — where a dense embedding happily
 * returns something semantically close and factually wrong. Lexical search nails
 * those; vectors handle paraphrase. RRF combines the two rankings without any
 * score calibration, which is what makes it robust across corpora.
 *
 *     rrf(d) = sum over lists L of 1 / (k + rank_L(d))
 *
 * k = 60 in the original Cormack et al. formulation and is exposed here so the
 * effect is measurable rather than magic.
 *
 * Tenant isolation is inherited from RLS: the query runs as the authenticated
 * role, so a tenant can only ever rank its own rows.
 */

import type { Queryable } from '../db/harness.js';

export interface RetrievedDocument {
  id: string;
  title: string;
  content: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  score: number;
}

export interface HybridSearchOptions {
  queryText: string;
  queryEmbedding: number[];
  limit?: number;
  rrfK?: number;
  /** Restrict to documents owned by this tenant. Redundant with RLS; kept for clarity in service-role paths. */
  userId?: string;
}

export async function hybridSearch(
  q: Queryable,
  options: HybridSearchOptions,
): Promise<RetrievedDocument[]> {
  const { queryText, queryEmbedding, limit = 5, rrfK = 60, userId } = options;

  const result = await q.query<{
    id: string;
    title: string;
    content: string;
    lexical_rank: number | null;
    vector_rank: number | null;
    score: number;
  }>(
    `
    with terms as (
      -- Build the tsquery from the parser's own lexemes, joined with OR.
      -- Two reasons: AND semantics (plainto_tsquery's default) destroys recall
      -- on multi-term questions, and building the query from lexemes means no
      -- user string is ever interpolated into tsquery syntax, so malformed
      -- input cannot raise a syntax error.
      select to_tsquery('english', string_agg(lexeme, ' | ')) as query
      from unnest(to_tsvector('english', $1))
    ),
    lexical as (
      select d.id,
             row_number() over (
               order by ts_rank(to_tsvector('english', d.content), (select query from terms)) desc
             )::int as rank
      from documents d
      where d.embedding is not null
        and (select query from terms) is not null
        and to_tsvector('english', d.content) @@ (select query from terms)
        and ($4::uuid is null or d.user_id = $4::uuid)
    ),
    dense as (
      select d.id,
             row_number() over (
               order by cosine_similarity(d.embedding, $2::double precision[]) desc
             )::int as rank
      from documents d
      where d.embedding is not null
        and ($4::uuid is null or d.user_id = $4::uuid)
    ),
    fused as (
      select coalesce(l.id, v.id) as id,
             l.rank as lexical_rank,
             v.rank as vector_rank,
             coalesce(1.0 / ($3::int + l.rank), 0) + coalesce(1.0 / ($3::int + v.rank), 0) as score
      from lexical l
      full outer join dense v on l.id = v.id
    )
    select f.id, d.title, d.content, f.lexical_rank, f.vector_rank, f.score
    from fused f
    join documents d on d.id = f.id
    order by f.score desc, d.title asc
    limit $5
    `,
    [queryText, `{${queryEmbedding.join(',')}}`, rrfK, userId ?? null, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    lexicalRank: row.lexical_rank,
    vectorRank: row.vector_rank,
    score: Number(row.score),
  }));
}

/** Cosine similarity, for callers that need to score a pair without a query. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('vector length mismatch');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
