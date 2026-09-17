/** Synthetic-only access check. Never uploads course files, logs a key, or connects to DB. */
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import { getVtArcConfig, validateArcBaseUrl } from '../config/rag';
import { GenerationProviderError, VtArcGenerationProvider } from '../services/ai/providers/VtArcGenerationProvider';

/** Recognize ARC's network gate without printing arbitrary upstream bodies. */
async function requiresCampusVpn(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const copy = response.clone();
  const reader = copy.body?.getReader();
  if (!reader) return false;
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < 16384) {
      const { done, value } = await reader.read();
      if (done) break;
      const bounded = value.subarray(0, 16384 - bytes);
      parts.push(bounded); bytes += bounded.length;
    }
  } finally { await reader.cancel(); }
  return /API access is restricted to the VT Campus VPN/i.test(Buffer.concat(parts).toString('utf8'));
}

async function main(): Promise<void> {
  const key = process.env.VT_ARC_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new GenerationProviderError('configuration');
  let baseUrl: string;
  try { baseUrl = validateArcBaseUrl(process.env.VT_ARC_BASE_URL || 'https://llm-api.arc.vt.edu/api/v1'); }
  catch { throw new GenerationProviderError('configuration'); }
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (await requiresCampusVpn(response)) {
    await response.body?.cancel();
    console.error(JSON.stringify({ step: 'network_access', endpoint: baseUrl,
      succeeded: false, code: 'network_restricted', upstreamStatus: response.status,
      message: 'ARC requires the VT Campus VPN. Connect this backend environment and retry; API key validity has not been evaluated.' }));
    process.exitCode = 1;
    return;
  }
  let modelIds: string[] = [];
  if (response.ok) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1048576) throw new GenerationProviderError('malformed_response');
    let body: any;
    try { body = JSON.parse(raw); } catch { throw new GenerationProviderError('malformed_response'); }
    const models = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    modelIds = models.map((model: any) => model.id).filter((id: unknown): id is string =>
      typeof id === 'string' && /^[\w./:-]{1,200}$/.test(id));
  } else await response.body?.cancel();
  console.log(JSON.stringify({ step: 'discovery', endpoint: baseUrl, status: response.status, modelIds }));
  if (process.argv.includes('--discover-only') && !response.ok) {
    throw new GenerationProviderError(response.status === 401 || response.status === 403 ? 'authentication' : 'unavailable');
  }
  if (process.argv.includes('--discover-only')) return;
  const requestedModel = process.argv.find(argument => argument.startsWith('--model='))?.slice('--model='.length);
  if (requestedModel) process.env.VT_ARC_MODEL = requestedModel;
  // A supplied model is required; discovery output provides IDs without guessing browser aliases.
  let config;
  try { config = getVtArcConfig(); } catch { throw new GenerationProviderError('configuration'); }
  if (modelIds.length && !modelIds.includes(config.model)) throw new GenerationProviderError('configuration');
  const provider = new VtArcGenerationProvider({ ...config, maxRetries: 0, maxOutputTokens: 256 });
  const result = await provider.generate({ messages: [
    { role: 'system', content: 'Use only the supplied synthetic evidence. Return a JSON object with status and blocks; each block has text and evidenceIds. Do not call tools or use web search.' },
    { role: 'user', content: 'Synthetic evidence E1: The demonstration course meets on Tuesday. When does it meet? Answer only as JSON with status "answered" and one block supported by evidenceIds ["E1"].' },
  ] });
  let parsed: any;
  try { parsed = JSON.parse(result.content); } catch { /* Capability not assumed from compatibility. */ }
  const structured = parsed?.status === 'answered' && Array.isArray(parsed.blocks) && parsed.blocks.length === 1 &&
    typeof parsed.blocks[0]?.text === 'string' && parsed.blocks[0]?.evidenceIds?.length === 1 &&
    parsed.blocks[0].evidenceIds[0] === 'E1';
  console.log(JSON.stringify({ step: 'synthetic_generation', provider: result.provider,
    model: result.model, succeeded: true, jsonEvidenceFormat: structured, usage: result.usage }));
  if (!structured) process.exitCode = 1;
}

main().catch(error => {
  const safe = error instanceof GenerationProviderError ? error : new GenerationProviderError('unavailable');
  console.error(JSON.stringify({ succeeded: false, code: safe.code, message: safe.message,
    upstreamStatus: safe.upstreamStatus }));
  process.exitCode = 1;
});
