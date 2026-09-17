import { getVtArcConfig } from '../../config/rag';
import { GenerationProvider } from './generation';
import { PostgresGenerationAdmission } from './providers/PostgresGenerationAdmission';
import { GenerationProviderError, VtArcGenerationProvider } from './providers/VtArcGenerationProvider';

let instance: GenerationProvider | undefined;

/** No grading adapter, mock default, or implicit cross-provider fallback. */
export function getGenerationProvider(): GenerationProvider {
  if (instance) return instance;
  if ((process.env.RAG_GENERATION_PROVIDER || 'vt_arc') !== 'vt_arc') {
    throw new GenerationProviderError('configuration');
  }
  try {
    const config = getVtArcConfig();
    // Deferred import prevents dotenv/db initialization in transport fixture tests and probe.
    const { pool } = require('../../config/database') as typeof import('../../config/database');
    instance = new VtArcGenerationProvider(config, {
      admission: new PostgresGenerationAdmission(pool, config.apiKey, config.model, config.concurrency, config.maxQueue),
    });
    return instance;
  } catch { throw new GenerationProviderError('configuration'); }
}
