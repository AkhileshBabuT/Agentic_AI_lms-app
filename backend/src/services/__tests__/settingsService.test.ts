import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../config/database', () => ({ pool: { query: (...a: any[]) => queryMock(...a) } }));

import { getSourceOfTruthMode, setSourceOfTruthMode, clearSettingsCache } from '../settingsService';

beforeEach(() => {
  queryMock.mockReset();
  clearSettingsCache();
});

describe('getSourceOfTruthMode', () => {
  it('returns the stored mode', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'external' }] });
    expect(await getSourceOfTruthMode()).toBe('external');
  });

  it('fails CLOSED to strict when the DB errors', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    expect(await getSourceOfTruthMode()).toBe('strict');
  });

  it('fails CLOSED to strict when the row is missing', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await getSourceOfTruthMode()).toBe('strict');
  });

  it('fails CLOSED to strict when the stored value is invalid', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'garbage' }] });
    expect(await getSourceOfTruthMode()).toBe('strict');
  });

  it('caches reads', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'strict' }] });
    await getSourceOfTruthMode();
    await getSourceOfTruthMode();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('setSourceOfTruthMode', () => {
  it('updates, audits, and busts the cache', async () => {
    queryMock.mockResolvedValue({ rows: [{ source_of_truth_mode: 'strict' }] });
    await setSourceOfTruthMode('external', 42);
    const sqls = queryMock.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => s.includes('UPDATE app_settings'))).toBe(true);
    expect(sqls.some(s => s.includes('app_settings_audit'))).toBe(true);
  });
});
