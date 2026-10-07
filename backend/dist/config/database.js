"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = exports.closeDB = exports.migrateDatabase = exports.connectDB = void 0;
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
const seed_1 = require("./seed");
dotenv_1.default.config();
const boundedInt = (value, fallback, min, max) => {
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
    ? new pg_1.Pool({
        ...poolOptions,
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
    : new pg_1.Pool({
        ...poolOptions,
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'lms_db',
        password: process.env.DB_PASSWORD || '040601',
        port: parseInt(process.env.DB_PORT || '5432'),
    });
exports.pool = pool;
const connectDB = async () => {
    try {
        const client = await pool.connect();
        console.log('Connected to PostgreSQL database');
        client.release();
        if (process.env.NODE_ENV !== 'production' && process.env.DB_AUTO_MIGRATE !== 'false') {
            await (0, exports.migrateDatabase)();
        }
        else {
            const schema = await pool.query("SELECT to_regclass('public.users') AS users, to_regclass('public.courses') AS courses, to_regclass('public.course_materials') AS materials, to_regclass('public.answer_runs') AS answers, to_regclass('public.app_schema_version') AS version_table");
            if (Object.values(schema.rows[0] ?? {}).some(value => value === null)) {
                throw new Error('Database schema is incomplete; run npm run db:migrate before API startup');
            }
            const version = await pool.query('SELECT version FROM app_schema_version WHERE singleton = true');
            if (version.rows[0]?.version !== 10) {
                throw new Error('Database schema version is incompatible; run npm run db:migrate before API startup');
            }
        }
        // Seed root user
        await (0, seed_1.seedRootUser)();
    }
    catch (error) {
        console.error('Database connection error:', error);
        throw error;
    }
};
exports.connectDB = connectDB;
const migrateDatabase = async () => {
    const { createTables } = await Promise.resolve().then(() => __importStar(require('../db/migrations/baseTables')));
    await createTables();
    const { runMigrations } = await Promise.resolve().then(() => __importStar(require('../db/migrations/runMigrations')));
    await runMigrations();
    await pool.query('CREATE TABLE IF NOT EXISTS app_schema_version (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO app_schema_version (singleton, version) VALUES (true, 10) ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version, updated_at = now()');
};
exports.migrateDatabase = migrateDatabase;
const closeDB = async () => pool.end();
exports.closeDB = closeDB;
//# sourceMappingURL=database.js.map