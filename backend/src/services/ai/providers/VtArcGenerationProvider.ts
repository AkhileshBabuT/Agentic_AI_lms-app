import { VtArcConfig, validateArcBaseUrl } from '../../../config/rag';
import { GenerationProvider, GenerationRequest, GenerationResult } from '../generation';

export type GenerationErrorCode = 'configuration' | 'authentication' | 'rate_limited' |
  'unavailable' | 'timeout' | 'cancelled' | 'malformed_response' | 'busy';

/** Safe to expose/log: never wraps request text, credentials, endpoint responses, or causes. */
export class GenerationProviderError extends Error {
  readonly status: number;
  constructor(readonly code: GenerationErrorCode, readonly retryAfterSeconds?: number,
    readonly upstreamStatus?: number) {
    const messages: Record<GenerationErrorCode, string> = {
      configuration: 'Course answer model is not configured correctly.',
      authentication: 'Course answer model access could not be authenticated.',
      rate_limited: 'Course answer model is busy. Please try again shortly.',
      unavailable: 'Course answer model is temporarily unavailable.',
      timeout: 'Course answer model did not respond within the allowed time.',
      cancelled: 'Course answer request was cancelled.',
      malformed_response: 'Course answer model returned an unusable response.',
      busy: 'Too many course answer requests are waiting. Please try again shortly.',
    };
    super(messages[code]);
    this.name = 'GenerationProviderError';
    this.status = code === 'timeout' ? 504 : code === 'cancelled' ? 499 :
      ['rate_limited', 'busy'].includes(code) ? 429 :
      ['authentication', 'malformed_response'].includes(code) ? 502 : 503;
  }
}

export interface GenerationLease {
  release(): Promise<void> | void;
  /** Losing a distributed lock connection cancels the in-flight provider request. */
  signal?: AbortSignal;
}
export interface GenerationAdmission { acquire(signal: AbortSignal): Promise<GenerationLease>; }

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new GenerationProviderError('cancelled')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new GenerationProviderError('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Bounded FIFO admission shared by requests using this adapter instance. */
export class LocalGenerationAdmission implements GenerationAdmission {
  private active = 0;
  private waiting: Array<{ signal: AbortSignal; resolve: (lease: GenerationLease) => void;
    reject: (err: GenerationProviderError) => void; onAbort: () => void }> = [];

  constructor(private readonly limit: number, private readonly maxQueue: number) {}

  acquire(signal: AbortSignal): Promise<GenerationLease> {
    if (signal.aborted) return Promise.reject(new GenerationProviderError('cancelled'));
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.lease()); }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new GenerationProviderError('busy'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, onAbort: () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(new GenerationProviderError('cancelled'));
      } };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private lease(): GenerationLease {
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort);
        next.resolve(this.lease());
      } else this.active--;
    } };
  }
}

interface ProviderDependencies {
  fetch?: typeof fetch;
  admission?: GenerationAdmission;
  delay?: typeof abortableDelay;
}

function retryDelaySeconds(response: Response, body: any): number | undefined {
  const value = body?.error?.retry_after_s ?? body?.retry_after_s;
  const header = response.headers.get('retry-after');
  const seconds = Number(value ?? header);
  if ((value !== undefined || header !== null) && Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  if (header) {
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  }
  return undefined;
}

async function readJsonLimited(response: Response, maxBytes: number): Promise<any> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new GenerationProviderError('malformed_response');
  if (!response.body) throw new GenerationProviderError('malformed_response');
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GenerationProviderError('malformed_response');
      }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GenerationProviderError('malformed_response'); }
  } finally { reader.releaseLock(); }
}

export class VtArcGenerationProvider implements GenerationProvider {
  private readonly transport: typeof fetch;
  private readonly admission: GenerationAdmission;
  private readonly delay: typeof abortableDelay;
  private readonly baseUrl: string;

  constructor(private readonly config: VtArcConfig, dependencies: ProviderDependencies = {}) {
    try { this.baseUrl = validateArcBaseUrl(config.baseUrl); }
    catch { throw new GenerationProviderError('configuration'); }
    if (!config.apiKey || /[\r\n]/.test(config.apiKey) || !config.model ||
        /legacy-tool-calling/i.test(config.model)) throw new GenerationProviderError('configuration');
    this.transport = dependencies.fetch ?? fetch;
    this.admission = dependencies.admission ?? new LocalGenerationAdmission(config.concurrency, config.maxQueue);
    this.delay = dependencies.delay ?? abortableDelay;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (!request.messages.length || request.messages.some(message =>
      !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
      throw new GenerationProviderError('configuration');
    }
    const controller = new AbortController();
    let timedOut = false;
    let lockLost = false;
    const onAbort = () => controller.abort();
    if (request.signal?.aborted) throw new GenerationProviderError('cancelled');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    const deadline = Date.now() + this.config.timeoutMs;
    let lease: GenerationLease | undefined;
    const onLockLost = () => { lockLost = true; controller.abort(); };
    try {
      lease = await this.admission.acquire(controller.signal);
      if (lease.signal?.aborted) onLockLost();
      else lease.signal?.addEventListener('abort', onLockLost, { once: true });
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        if (controller.signal.aborted) throw new GenerationProviderError('cancelled');
        let response: Response;
        try {
          response = await this.transport(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
            redirect: 'error',
            signal: controller.signal,
            body: JSON.stringify({
              model: this.config.model,
              messages: request.messages,
              stream: false,
              max_tokens: this.config.maxOutputTokens,
              temperature: 0,
              // Never send ARC RAG files, web tools, or function calls; local evidence is authoritative.
              tool_ids: [],
              ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
            }),
          });
        } catch {
          if (controller.signal.aborted) throw new GenerationProviderError('cancelled');
          // A failed POST may already have been accepted upstream. Avoid duplicate uncertain requests.
          throw new GenerationProviderError('unavailable');
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new GenerationProviderError('authentication', undefined, response.status);
        }
        const transient = response.status === 429 || [502, 503, 504].includes(response.status);
        if (!response.ok) {
          let body: any;
          try { body = await readJsonLimited(response, this.config.maxResponseBytes); }
          catch { /* Error pages are not answer content and must never reach logs. */ }
          const waitSeconds = retryDelaySeconds(response, body);
          const code = response.status === 429 ? 'rate_limited' : 'unavailable';
          const waitMs = waitSeconds === undefined ? 500 * (attempt + 1) : waitSeconds * 1000;
          if (transient && attempt < this.config.maxRetries && Date.now() + waitMs < deadline) {
            await this.delay(waitMs, controller.signal);
            continue;
          }
          throw new GenerationProviderError(code, waitSeconds, response.status);
        }
        const body = await readJsonLimited(response, this.config.maxResponseBytes);
        if (controller.signal.aborted) throw new GenerationProviderError('cancelled');
        const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
        const content = choice?.message?.content;
        if (typeof content !== 'string' || !content.trim() ||
            choice?.message?.tool_calls?.length ||
            (choice?.finish_reason && choice.finish_reason !== 'stop')) {
          throw new GenerationProviderError('malformed_response');
        }
        const inputTokens = body?.usage?.prompt_tokens;
        const outputTokens = body?.usage?.completion_tokens;
        return {
          content: content.trim(), provider: 'vt_arc', model: this.config.model,
          usage: {
            inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : undefined,
            outputTokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : undefined,
          },
        };
      }
      throw new GenerationProviderError('unavailable');
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GenerationProviderError(timedOut ? 'timeout' : lockLost ? 'unavailable' : 'cancelled');
      }
      if (error instanceof GenerationProviderError) throw error;
      throw new GenerationProviderError('unavailable');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      lease?.signal?.removeEventListener('abort', onLockLost);
      try { await lease?.release(); } catch { /* Release implementation destroys uncertain lock connection. */ }
    }
  }
}
