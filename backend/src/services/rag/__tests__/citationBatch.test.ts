import { describe, expect, it } from 'vitest';
import { getAuthorizedAnswerRecords } from '../CitationService';

describe('bulk answer citation reads', () => {
  it('reads a page once and withholds every source on a partially revoked answer', async () => {
    const query = async (_sql: string, _values?: any[]) => ({ rows: [
      { message_id: 11, answer_run_id: 1, citation_id: 1, citation_number: 1,
        evidence_id: 'E1', chunk_id: 'c1', excerpt: 'First', locator: { page: 2 }, accessible: true },
      { message_id: 11, answer_run_id: 1, citation_id: 2, citation_number: 2,
        evidence_id: 'E2', chunk_id: 'c2', excerpt: 'Revoked', locator: { page: 3 }, accessible: false },
      { message_id: 12, answer_run_id: null, citation_id: null, accessible: false },
    ] });
    let calls = 0;
    const db = { query: async (sql: string, values?: any[]) => { calls++; return query(sql, values); } };
    const records = await getAuthorizedAnswerRecords([11, 12], 7, 'student', db);
    expect(calls).toBe(1);
    expect(records.get(11)).toEqual({ sources: [], restricted: true });
    expect(records.get(12)).toEqual({ sources: [], restricted: false });
  });
  it('rejects a page when access to any requested answer disappears', async () => {
    const db = { query: async () => ({ rows: [{ message_id: 11, citation_id: null }] }) };
    await expect(getAuthorizedAnswerRecords([11, 12], 7, 'student', db)).rejects.toMatchObject({ status: 403 });
  });
});
