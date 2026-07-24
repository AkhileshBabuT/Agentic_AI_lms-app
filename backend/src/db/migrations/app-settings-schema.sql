-- Global application settings: single row, id locked to 1.
CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_of_truth_mode TEXT NOT NULL DEFAULT 'strict'
    CHECK (source_of_truth_mode IN ('strict', 'external')),
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Audit trail: who flipped what, when.
CREATE TABLE IF NOT EXISTS app_settings_audit (
  id SERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by INT REFERENCES users(id),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
