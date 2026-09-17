import { Worker } from 'worker_threads';
import path from 'path';
import { RAG_CONFIG } from '../../config/rag';

type Operation = 'embed' | 'rerank';
interface Task {
  id: number; question: string; texts?: string[]; signal?: AbortSignal;
  resolve: (value: number[]) => void; reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>; abort?: () => void;
}
function inferenceError(message: string): Error { return Object.assign(new Error(message), { status: 503 }); }
function disposeWorker(worker?: Worker): void {
  if (!worker) return;
  worker.removeAllListeners();
  worker.on('error', () => { /* Ignore late failures belonging to a cancelled task. */ });
  void worker.terminate().catch(() => { /* Already shutting down. */ });
}
/** One isolated worker and bounded queue per model; deadlines kill CPU inference and recreate lazily. */
class ModelLane {
  private worker?: Worker;
  private active?: Task;
  private queue: Task[] = [];
  private sequence = 0;
  ready = false;
  constructor(private operation: Operation) {}
  run(question: string, texts: string[] | undefined, timeout: number, signal?: AbortSignal): Promise<number[]> {
    if (signal?.aborted) return Promise.reject(inferenceError('Request cancelled'));
    if (this.queue.length >= RAG_CONFIG.MODEL_QUEUE_LIMIT) return Promise.reject(inferenceError('Local inference is busy. Please try again.'));
    return new Promise((resolve, reject) => {
      const task: Task = { id: ++this.sequence, question, texts, signal, resolve, reject };
      task.abort = () => this.expire(task, inferenceError('Request cancelled'));
      task.timer = setTimeout(() => this.expire(task, inferenceError('Local inference timed out. Please try again.')), timeout);
      signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task); this.dispatch();
    });
  }
  private finish(task: Task, error?: Error, value?: number[]): void {
    if (task.timer) clearTimeout(task.timer);
    if (task.abort) task.signal?.removeEventListener('abort', task.abort);
    if (error) task.reject(error); else task.resolve(value!);
  }
  private expire(task: Task, error: Error): void {
    if (this.active === task) {
      const old = this.worker; this.worker = undefined; this.active = undefined;
      this.ready = false;
      disposeWorker(old);
      this.finish(task, error); this.dispatch();
    } else {
      const index = this.queue.indexOf(task);
      if (index >= 0) { this.queue.splice(index, 1); this.finish(task, error); }
    }
  }
  private dispatch(): void {
    if (this.active || !this.queue.length) return;
    this.active = this.queue.shift()!;
    try {
      if (!this.worker) {
        const ts = __filename.endsWith('.ts');
        this.worker = new Worker(path.join(__dirname, `RagModelWorker.${ts ? 'ts' : 'js'}`), ts ? { execArgv: ['-r', 'ts-node/register/transpile-only'] } : undefined);
        const worker = this.worker;
        worker.on('message', ({ id, value, error }) => {
          if (this.worker !== worker || this.active?.id !== id) return;
          const task = this.active; this.active = undefined;
          if (!task) return;
          const valid = Array.isArray(value) && value.length === (this.operation === 'embed' ? 768 : task.texts?.length) && value.length > 0 && value.every(n => Number.isFinite(n));
          this.ready = !error && valid;
          this.finish(task, error || !valid ? inferenceError('Local model inference failed') : undefined, value);
          worker.unref(); this.dispatch();
        });
        const failed = () => {
          if (this.worker !== worker) return;
          const task = this.active; this.active = undefined; this.worker = undefined;
          this.ready = false;
          disposeWorker(worker);
          if (task) this.finish(task, inferenceError('Local model inference failed'));
          this.dispatch();
        };
        worker.on('error', failed); worker.on('exit', failed);
      }
      this.worker.ref();
      this.worker.postMessage({ id: this.active.id, operation: this.operation, question: this.active.question, texts: this.active.texts });
    } catch { if (this.active) this.expire(this.active, inferenceError('Local model worker could not start')); }
  }
}
const embeddings = new ModelLane('embed');
const reranking = new ModelLane('rerank');
export function embedRagQuery(question: string, signal?: AbortSignal): Promise<number[]> {
  return embeddings.run(question, undefined, RAG_CONFIG.EMBEDDING_TIMEOUT_MS, signal);
}
export function rerankRagTexts(question: string, texts: string[], timeout: number, signal?: AbortSignal): Promise<number[]> {
  return reranking.run(question, texts, timeout, signal);
}
export function getRagModelReadiness(): { embedding: boolean; reranker: boolean } {
  return { embedding: embeddings.ready, reranker: reranking.ready };
}
/** Synthetic local warmup only; no provider request or course content. */
export async function warmRagModels(signal?: AbortSignal): Promise<void> {
  await embedRagQuery('Course index readiness check.', signal);
  // Cold model startup gets a warmup deadline; warmed requests retain the short rerank deadline.
  if (RAG_CONFIG.RERANK_ENABLED) await rerankRagTexts('Readiness check', ['A course index.', 'A synthetic readiness example.'], RAG_CONFIG.EMBEDDING_TIMEOUT_MS, signal);
}
