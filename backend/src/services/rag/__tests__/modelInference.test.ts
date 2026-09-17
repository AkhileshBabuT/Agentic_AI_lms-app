import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock('../../../config/rag', () => ({ RAG_CONFIG: { MODEL_QUEUE_LIMIT: 2, EMBEDDING_TIMEOUT_MS: 100 } }));
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  return { Worker: class extends EventEmitter {
    sent: any[] = []; terminate = vi.fn().mockResolvedValue(0); ref = vi.fn(); unref = vi.fn();
    constructor() { super(); state.workers.push(this); }
    postMessage(message: any) { this.sent.push(message); }
  } };
});
describe('bounded isolated inference admission and termination', () => {
  const vector = (value: number) => [value, ...Array(767).fill(0)];
  beforeEach(() => { state.workers = []; vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('terminates timed-out CPU inference and recreates worker for the next request', async () => {
    const { embedRagQuery, getRagModelReadiness } = await import('../modelInference');
    expect(getRagModelReadiness().embedding).toBe(false);
    const timedOut = expect(embedRagQuery('slow')).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(101); await timedOut;
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
    const next = embedRagQuery('next');
    const worker = state.workers[1];
    worker.emit('message', { id: worker.sent[0].id, value: vector(1) });
    await expect(next).resolves.toEqual(vector(1));
    expect(getRagModelReadiness().embedding).toBe(true);
  });
  it('bounds queue capacity and cancels queued requests without disturbing active inference', async () => {
    const { embedRagQuery } = await import('../modelInference');
    const active = embedRagQuery('active');
    const controller = new AbortController();
    const queued = expect(embedRagQuery('queued', controller.signal)).rejects.toMatchObject({ status: 503 });
    const other = embedRagQuery('other');
    await expect(embedRagQuery('overflow')).rejects.toMatchObject({ status: 503 });
    controller.abort(); await queued;
    const worker = state.workers[0];
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', { id: worker.sent[0].id, value: vector(1) });
    await expect(active).resolves.toEqual(vector(1));
    expect(worker.sent[1].question).toBe('other');
    worker.emit('message', { id: worker.sent[1].id, value: vector(2) });
    await expect(other).resolves.toEqual(vector(2));
  });
  it('terminates active inference on cancellation and sanitizes malformed results', async () => {
    const { embedRagQuery } = await import('../modelInference');
    const controller = new AbortController();
    const cancelled = expect(embedRagQuery('active', controller.signal)).rejects.toMatchObject({ status: 503 });
    controller.abort(); await cancelled;
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
    const malformed = expect(embedRagQuery('next')).rejects.toThrow('Local model inference failed');
    const worker = state.workers[1];
    worker.emit('message', { id: worker.sent[0].id, value: [NaN] }); await malformed;
  });
});
