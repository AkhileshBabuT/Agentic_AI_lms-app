import type { CourseSource } from '../types/rag';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

export interface StreamMessage {
  id: number;
  session_id: number;
  sender_type: 'student' | 'agent' | 'system';
  content: string;
  message_metadata: Record<string, unknown> | null;
  sources?: CourseSource[];
  created_at: string;
}

export class ChatStreamError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code = 'temporarily_unavailable', status?: number) {
    super(message); this.code = code; this.status = status;
  }
}

export interface ChatStreamHandlers {
  accepted: (studentMessage: StreamMessage) => void;
  stage: (stage: string) => void;
  complete: (agentMessage: StreamMessage) => void;
}

/** A POST stream carries progress labels only; answer text arrives in the complete event. */
export async function submitChatStream(sessionId: number, content: string, requestKey: string,
  handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  const token = localStorage.getItem('token');
  const response = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}/messages/stream`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream',
      'Idempotency-Key': requestKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ChatStreamError(body.error || 'The course assistant is unavailable.',
      response.status === 409 ? 'conflict' : 'temporarily_unavailable', response.status);
  }
  if (!response.body) throw new ChatStreamError('The connection ended before an answer arrived.', 'disconnected');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  const consume = (frame: string) => {
    const event = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7);
    const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
    if (!event || !dataLine) return;
    const data = JSON.parse(dataLine.slice(6));
    if (event === 'accepted') handlers.accepted(data.studentMessage);
    else if (event === 'stage') handlers.stage(data.stage);
    else if (event === 'complete') { completed = true; handlers.complete(data.agentMessage); }
    else if (event === 'error') throw new ChatStreamError(data.message, data.code);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!completed) throw new ChatStreamError('The connection ended before an answer arrived.', 'disconnected');
  } finally { reader.releaseLock(); }
}
