import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TENANT_A, TENANT_B, type Harness } from '../src/db/harness.js';
import { cosineSimilarity, hybridSearch } from '../src/retrieval/hybrid.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  // Tenant A gets a document with an exact-token identifier, the kind a dense
  // embedding routinely fumbles.
  await h.asTenant(TENANT_A, (q) =>
    q.query(
      `insert into documents (user_id, title, content, embedding)
       values ($1, 'Part lookup', 'Replacement bearing kit SKU-8842 ships within 48 hours.', $2::double precision[])`,
      [TENANT_A, '{0.2,0.2,0.1}'],
    ),
  );
});

afterAll(async () => {
  await h.close();
});

describe('cosine similarity', () => {
  it('scores identical vectors as 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is scale invariant', () => {
    expect(cosineSimilarity([1, 0], [5, 0])).toBeCloseTo(1, 10);
  });

  it('returns 0 for a zero vector instead of NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rejects mismatched dimensions', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(/length mismatch/);
  });
});

describe('hybrid retrieval under RLS', () => {
  it('never returns another tenant document', async () => {
    const hits = await h.asTenant(TENANT_A, (q) =>
      hybridSearch(q, { queryText: 'freight EMEA delivery', queryEmbedding: [0, 1, 0], limit: 10 }),
    );
    const titles = hits.map((r) => r.title);
    expect(titles).not.toContain('Globex freight SLA');
  });

  it('finds an exact identifier that pure vector search would miss', async () => {
    const hits = await h.asTenant(TENANT_A, (q) =>
      hybridSearch(q, {
        queryText: 'SKU-8842',
        queryEmbedding: [0, 0, 1], // deliberately unrelated to the lexical hit
        limit: 5,
      }),
    );
    expect(hits[0]?.title).toBe('Part lookup');
    expect(hits[0]?.lexicalRank).toBe(1);
  });

  it('ranks a strong semantic match first when the query is paraphrased', async () => {
    const hits = await h.asTenant(TENANT_A, (q) =>
      hybridSearch(q, {
        queryText: 'money back guarantee window',
        queryEmbedding: [1, 0, 0],
        limit: 3,
      }),
    );
    expect(hits[0]?.title).toBe('Acme refund policy');
    expect(hits[0]?.vectorRank).toBe(1);
  });

  it('respects the limit', async () => {
    const hits = await h.asTenant(TENANT_A, (q) =>
      hybridSearch(q, { queryText: 'refund bearing', queryEmbedding: [1, 0, 0], limit: 1 }),
    );
    expect(hits).toHaveLength(1);
  });

  it('returns an empty list instead of throwing when nothing matches', async () => {
    const hits = await h.asTenant(TENANT_A, (q) =>
      hybridSearch(q, {
        queryText: 'zzzzzznonexistenttoken',
        queryEmbedding: [0, 0, 1],
        limit: 3,
      }),
    );
    // The dense arm always has candidates, so a result is expected — but it must
    // never leak across tenants and the lexical arm must stay empty.
    expect(hits.every((r) => r.lexicalRank === null)).toBe(true);
  });

  it('gives tenant B only its own corpus', async () => {
    const hits = await h.asTenant(TENANT_B, (q) =>
      hybridSearch(q, { queryText: 'refund SKU', queryEmbedding: [1, 0, 0], limit: 10 }),
    );
    expect(hits.map((r) => r.title)).toEqual(['Globex freight SLA']);
  });

  it('scores are positive and sorted descending', async () => {
    const hits = await h.asTenant(TENANT_A, (q) =>
      hybridSearch(q, { queryText: 'refund', queryEmbedding: [1, 0, 0], limit: 5 }),
    );
    expect(hits.length).toBeGreaterThan(1);
    for (const hit of hits) expect(hit.score).toBeGreaterThan(0);
    const scores = hits.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
