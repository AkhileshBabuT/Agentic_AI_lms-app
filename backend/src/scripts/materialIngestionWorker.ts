import 'dotenv/config';
import { pool } from '../config/database';
import { runIngestionWorker } from '../services/materials/ingestionWorker';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
// Apply the normal application migrations first; workers never initialize/seed data.
runIngestionWorker(controller.signal).finally(() => pool.end()).catch(() => {
  console.error('Material ingestion worker stopped unexpectedly'); process.exitCode = 1;
});
