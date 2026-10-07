import { Pool } from 'pg';
import dotenv from 'dotenv';
import { seedRootUser } from './seed';

dotenv.config();

const boundedInt = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};
const poolOptions = {
  max: boundedInt(process.env.DB_POOL_MAX, 10, 2, 50),
  connectionTimeoutMillis: boundedInt(process.env.DB_CONNECTION_TIMEOUT_MS, 5000, 100, 30000),
  idleTimeoutMillis: boundedInt(process.env.DB_IDLE_TIMEOUT_MS, 30000, 1000, 300000),
  statement_timeout: boundedInt(process.env.DB_STATEMENT_TIMEOUT_MS, 30000, 1000, 300000),
};

// Support both DATABASE_URL (Railway/Render) and individual connection params
const pool = process.env.DATABASE_URL
  ? new Pool({
      ...poolOptions,
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
  : new Pool({
      ...poolOptions,
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'lms_db',
      password: process.env.DB_PASSWORD || '040601',
      port: parseInt(process.env.DB_PORT || '5432'),
    });

export const connectDB = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database');
    client.release();

    if (process.env.NODE_ENV !== 'production' && process.env.DB_AUTO_MIGRATE !== 'false') {
      await migrateDatabase();
    } else {
      const schema = await pool.query(
        "SELECT to_regclass('public.users') AS users, to_regclass('public.courses') AS courses, to_regclass('public.course_materials') AS materials, to_regclass('public.answer_runs') AS answers, to_regclass('public.app_schema_version') AS version_table"
      );
      if (Object.values(schema.rows[0] ?? {}).some(value => value === null)) {
        throw new Error('Database schema is incomplete; run npm run db:migrate before API startup');
      }
      const version = await pool.query('SELECT version FROM app_schema_version WHERE singleton = true');
      if (version.rows[0]?.version !== 10) {
        throw new Error('Database schema version is incompatible; run npm run db:migrate before API startup');
      }
    }

    // Seed root user
    await seedRootUser();
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
};

export const migrateDatabase = async () => {
  const { createTables } = await import('../db/migrations/baseTables');
  await createTables();
  const { runMigrations } = await import('../db/migrations/runMigrations');
  await runMigrations();
  await pool.query('CREATE TABLE IF NOT EXISTS app_schema_version (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  await pool.query('INSERT INTO app_schema_version (singleton, version) VALUES (true, 10) ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version, updated_at = now()');
};

export const closeDB = async () => pool.end();

export { pool };
