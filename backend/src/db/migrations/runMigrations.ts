import { pool } from '../../config/database';
import fs from 'fs';
import path from 'path';

/**
 * Run database migrations
 * This ensures the multi-agent HITL schema is applied
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();

  try {
    console.log('Running database migrations...');

    // Migration 1: Multi-agent HITL schema
    const hitlMigrationPath = path.join(__dirname, 'multi-agent-hitl-schema.sql');
    const hitlMigrationSQL = fs.readFileSync(hitlMigrationPath, 'utf8');
    await client.query(hitlMigrationSQL);
    console.log('✓ Multi-agent HITL schema migration completed successfully');

    // Migration 2: New Agent System (Grading Assistant, Chatbot, Integrity Verifier)
    const newAgentMigrationPath = path.join(__dirname, 'new-agent-system-schema.sql');
    const newAgentMigrationSQL = fs.readFileSync(newAgentMigrationPath, 'utf8');
    await client.query(newAgentMigrationSQL);
    console.log('✓ New Agent System schema migration completed successfully');

    // Migration 3: RAG System (Document extraction, embeddings, vector search)
    const ragMigrationPath = path.join(__dirname, 'rag-system-schema.sql');
    const ragMigrationSQL = fs.readFileSync(ragMigrationPath, 'utf8');
    await client.query(ragMigrationSQL);
    console.log('✓ RAG System schema migration completed successfully');

    // Migration 4: Fact-Check System (Groq independent verification)
    const factCheckMigrationPath = path.join(__dirname, 'fact-check-schema.sql');
    const factCheckMigrationSQL = fs.readFileSync(factCheckMigrationPath, 'utf8');
    await client.query(factCheckMigrationSQL);
    console.log('✓ Fact-Check schema migration completed successfully');

    // Migration 5: Material Folders (hierarchical folder system for course materials)
    const foldersMigrationPath = path.join(__dirname, 'material-folders-schema.sql');
    const foldersMigrationSQL = fs.readFileSync(foldersMigrationPath, 'utf8');
    await client.query(foldersMigrationSQL);
    console.log('✓ Material Folders schema migration completed successfully');

    // Migration 6: Validation Score (separate validation score + verifier-disagreement flag)
    const validationScoreMigrationPath = path.join(__dirname, 'validation-score-schema.sql');
    const validationScoreMigrationSQL = fs.readFileSync(validationScoreMigrationPath, 'utf8');
    await client.query(validationScoreMigrationSQL);
    console.log('✓ Validation Score schema migration completed successfully');

    // Migration 7: App settings (global source-of-truth mode + audit trail)
    const appSettingsMigrationPath = path.join(__dirname, 'app-settings-schema.sql');
    const appSettingsMigrationSQL = fs.readFileSync(appSettingsMigrationPath, 'utf8');
    await client.query(appSettingsMigrationSQL);
    console.log('✓ App Settings schema migration completed successfully');

    // Migration 8: durable versioned course-material ingestion (no backfill at boot).
    await client.query(fs.readFileSync(path.join(__dirname, 'material-ingestion-schema.sql'), 'utf8'));

    // Migration 9: immutable evidence and assistant-owned course-answer citations.
    await client.query(fs.readFileSync(path.join(__dirname, 'rag-answers-schema.sql'), 'utf8'));

  } catch (error) {
    console.error('Error running migrations:', error);
    throw error;
  } finally {
    client.release();
  }
}
