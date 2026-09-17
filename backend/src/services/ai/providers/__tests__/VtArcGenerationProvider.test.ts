import { afterEach, describe, expect, it, vi } from 'vitest';
import { VtArcConfig, getVtArcConfig, validateArcBaseUrl } from '../../../../config/rag';
import { GenerationProviderError, LocalGenerationAdmission, VtArcGenerationProvider } from '../VtArcGenerationProvider';

const config: VtArcConfig = {
  apiKey: 'fixture-secret-never-log', baseUrl: 'https://llm-api.arc.vt.edu/api/v1',
  model: 'verified-fixture-model', timeoutMs: 1000, concurrency: 1, maxQueue: 1,
  maxRetries: 1, maxOutputTokens: 1500, maxResponseBytes: 4096,
};
const request = { messages: [{ role: 'user' as const, content: 'Synthetic prompt' }] };
const success = () => new Response(JSON.stringify({
  choices: [{ message: { content: '{"status":"answered","blocks":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8 },
}), { status: 200 });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('ARC configuration boundary', () => {
  it('accepts only the canonical documented gateway including trailing slash', () => {
    expect(validateArcBaseUrl('https://llm-api.arc.vt.edu/api/v1/')).toBe(config.baseUrl);
    for (const url of ['http://llm-api.arc.vt.edu/api/v1', 'https://llm.arc.vt.edu/api/v1',
      'https://llm-api.arc.vt.edu.evil.example/api/v1', 'https://llm-api.arc.vt.edu:444/api/v1',
      'https://user:secret@llm-api.arc.vt.edu/api/v1', 'https://llm-api.arc.vt.edu/api/v1?key=secret',
      'https://llm-api.arc.vt.edu/api/v1#secret', 'https://llm-api.arc.vt.edu/api/v1/redirect']) {
      expect(() => validateArcBaseUrl(url)).toThrow();
    }
  });

  it('requires explicit model/key, rejects legacy tools, and omits raw environment values', () => {
    vi.stubEnv('VT_ARC_API_KEY', config.apiKey);
    vi.stubEnv('VT_ARC_MODEL', '');
    expect(() => getVtArcConfig()).toThrow(/VT_ARC_MODEL/);
    vi.stubEnv('VT_ARC_MODEL', 'verified-fixture-model-legacy-tool-calling');
    expect(() => getVtArcConfig()).toThrow(/legacy/);
    vi.stubEnv('VT_ARC_MODEL', config.model);
    vi.stubEnv('VT_ARC_CONCURRENCY', config.apiKey);
    try { getVtArcConfig(); throw new Error('Expected invalid config'); }
    catch (error) { expect(String(error)).not.toContain(config.apiKey); }
    vi.stubEnv('VT_ARC_CONCURRENCY', '2');
    vi.stubEnv('VT_ARC_API_KEY', '');
    expect(() => getVtArcConfig()).toThrow(/VT_ARC_API_KEY/);
  });
});

describe('VT ARC generation transport', () => {
  it('sends buffered generation only, disallows redirects/tools, and preserves usage', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(success());
    const result = await new VtArcGenerationProvider(config, { fetch: transport }).generate(request);
    expect(result).toMatchObject({ provider: 'vt_arc', model: config.model, usage: { inputTokens: 12, outputTokens: 8 } });
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe(`${config.baseUrl}/chat/completions`);
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${config.apiKey}` });
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: config.model, messages: request.messages, stream: false, tool_ids: [], temperature: 0 });
    expect(body).not.toHaveProperty('files');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('response_format'); // Unsupported structured-output capability is not assumed.
  });

  it.each([401, 403])('sanitizes authentication failure %s without retry', async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(`secret ${config.apiKey}`, { status }));
    const provider = new VtArcGenerationProvider(config, { fetch: transport });
    let caught: unknown;
    try { await provider.generate(request); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'authentication', status: 502 });
    expect(String(caught)).not.toContain(config.apiKey);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('honors ARC body retry_after_s without assuming a Retry-After header', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { retry_after_s: 0 } }), { status: 429 }))
      .mockResolvedValueOnce(success());
    const delay = vi.fn().mockResolvedValue(undefined);
    await new VtArcGenerationProvider(config, { fetch: transport, delay }).generate(request);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(0, expect.any(AbortSignal));
  });

  it('does not retry earlier than upstream backoff or exceed its total deadline', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { retry_after_s: 30 } }), { status: 429 }));
    const delay = vi.fn().mockResolvedValue(undefined);
    await expect(new VtArcGenerationProvider(config, { fetch: transport, delay }).generate(request))
      .rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
    expect(delay).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('limits server-error retry and sanitizes network exception causes without retry', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<html>private upstream error</html>', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(new VtArcGenerationProvider(config, { fetch: transport, delay: vi.fn().mockResolvedValue(undefined) })
      .generate(request)).rejects.toMatchObject({ code: 'unavailable' });
    expect(transport).toHaveBeenCalledTimes(2);
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error(config.apiKey));
    const result = new VtArcGenerationProvider(config, { fetch: failing }).generate(request);
    await expect(result).rejects.toMatchObject({ code: 'unavailable' });
    await expect(result).rejects.not.toThrow(config.apiKey);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it.each([
    'not json', JSON.stringify({ choices: [] }),
    JSON.stringify({ choices: [{ message: { content: '' } }] }),
    JSON.stringify({ choices: [{ message: { content: [{ text: 'text' }] } }] }),
    JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }),
    JSON.stringify({ choices: [{ message: { content: 'text', tool_calls: [{ name: 'web_search' }] } }] }),
  ])('rejects malformed/truncated/tool output without repair inside transport', async body => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(new VtArcGenerationProvider(config, { fetch: transport }).generate(request))
      .rejects.toMatchObject({ code: 'malformed_response' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds response body memory', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(config.maxResponseBytes + 1)));
    await expect(new VtArcGenerationProvider(config, { fetch: transport }).generate(request))
      .rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('cancels fetch and releases admission on caller cancellation', async () => {
    const release = vi.fn();
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    }));
    await expect(new VtArcGenerationProvider(config, {
      fetch: transport, admission: { acquire: async () => ({ release }) },
    }).generate({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('times out the entire operation and releases admission', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = new VtArcGenerationProvider(config, {
      fetch: transport, admission: { acquire: async () => ({ release }) },
    }).generate(request);
    const check = expect(pending).rejects.toMatchObject({ code: 'timeout', status: 504 });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(release).toHaveBeenCalledOnce();
  });

  it('cancels generation if the distributed lease is lost', async () => {
    const lock = new AbortController();
    const release = vi.fn();
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      lock.abort();
    }));
    await expect(new VtArcGenerationProvider(config, {
      fetch: transport, admission: { acquire: async () => ({ release, signal: lock.signal }) },
    }).generate(request)).rejects.toMatchObject({ code: 'unavailable' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an already-cancelled request before network access', async () => {
    const controller = new AbortController(); controller.abort();
    const transport = vi.fn<typeof fetch>();
    await expect(new VtArcGenerationProvider(config, { fetch: transport }).generate({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('bounded local admission', () => {
  it('enforces active and queue bounds, skips cancelled waiters, and releases idempotently', async () => {
    const admission = new LocalGenerationAdmission(1, 1);
    const first = await admission.acquire(new AbortController().signal);
    const controller = new AbortController();
    const second = admission.acquire(controller.signal);
    const cancellation = expect(second).rejects.toMatchObject({ code: 'cancelled' });
    await expect(admission.acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'busy' });
    controller.abort(); await cancellation;
    const third = admission.acquire(new AbortController().signal);
    await first.release(); await first.release();
    const next = await third;
    const fourth = admission.acquire(new AbortController().signal);
    await expect(admission.acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'busy' });
    await next.release();
    await (await fourth).release();
  });
});
