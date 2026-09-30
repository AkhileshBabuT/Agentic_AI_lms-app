import 'dotenv/config';
import { closeDB, migrateDatabase } from '../config/database';

migrateDatabase()
  .then(() => process.stdout.write('Database migrations complete\n'))
  .catch(() => { process.stderr.write('Database migration failed\n'); process.exitCode = 1; })
  .finally(() => closeDB());
