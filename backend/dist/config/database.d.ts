import { Pool } from 'pg';
declare const pool: Pool;
export declare const connectDB: () => Promise<void>;
export declare const migrateDatabase: () => Promise<void>;
export declare const closeDB: () => Promise<void>;
export { pool };
//# sourceMappingURL=database.d.ts.map