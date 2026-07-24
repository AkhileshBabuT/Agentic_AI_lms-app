import { pool } from '../config/database';

export type SourceOfTruthMode = 'strict' | 'external';

const CACHE_TTL_MS = 60_000;
let cached: { mode: SourceOfTruthMode; at: number } | null = null;

/**
 * Global source-of-truth mode. FAIL-CLOSED: any read problem returns 'strict'
 * (course materials only) — external knowledge must never leak in by accident.
 */
export async function getSourceOfTruthMode(): Promise<SourceOfTruthMode> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.mode;
  try {
    const result = await pool.query('SELECT source_of_truth_mode FROM app_settings WHERE id = 1');
    const mode: SourceOfTruthMode =
      result.rows[0]?.source_of_truth_mode === 'external' ? 'external' : 'strict';
    cached = { mode, at: Date.now() };
    return mode;
  } catch (error) {
    console.error('Settings read failed — failing closed to strict mode:', error);
    return 'strict';
  }
}

export async function setSourceOfTruthMode(mode: SourceOfTruthMode, userId: number): Promise<void> {
  const previous = await getSourceOfTruthMode();
  await pool.query(
    'UPDATE app_settings SET source_of_truth_mode = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [mode, userId]
  );
  await pool.query(
    'INSERT INTO app_settings_audit (setting_key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)',
    ['source_of_truth_mode', previous, mode, userId]
  );
  cached = null;
}

/** Test hook. */
export function clearSettingsCache(): void {
  cached = null;
}
