// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import ChatInterface from './ChatInterface';
import { chatAPI } from '../services/api';
import { submitChatStream } from '../services/chatStream';
import type { ChatStreamHandlers, StreamMessage } from '../services/chatStream';

vi.mock('../services/api', () => ({ chatAPI: { getSession: vi.fn(), getMessages: vi.fn() } }));
vi.mock('../services/chatStream', () => ({ submitChatStream: vi.fn() }));
vi.mock('../components/Toast', () => {
  const showToast = vi.fn();
  return { useToast: () => ({ showToast }) };
});
vi.mock('../components/MessageMetadata', () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const message = (session: number, id: number, content: string, sender_type: 'student' | 'agent' = 'student'): StreamMessage =>
  ({ id, session_id: session, sender_type, content, message_metadata: {}, created_at: new Date().toISOString() });
const response = <T,>(data: T): AxiosResponse<T> =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
const session = (id: number) => response({ session: { id, course_name: `Course ${id}` } });
const messages = (id: number) => response({ messages: [message(id, id, `History ${id}`)] });

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

function RouteButtons() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate('/chat/1')}>Go A</button><button onClick={() => navigate('/chat/2')}>Go B</button></>;
}

function renderChat() {
  render(<MemoryRouter initialEntries={['/chat/1']}><RouteButtons /><Routes>
    <Route path="/chat/:sessionId" element={<ChatInterface />} />
  </Routes></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('chat route isolation', () => {
  it('aborts A stream, rejects late stream events, and resets draft and retry on A to B', async () => {
    vi.mocked(chatAPI.getSession).mockImplementation(async id => session(id));
    vi.mocked(chatAPI.getMessages).mockImplementation(async id => messages(id));
    const first = deferred<void>();
    let handlers!: ChatStreamHandlers;
    let signal!: AbortSignal;
    vi.mocked(submitChatStream).mockImplementation(async (_id, _content, _key, callbacks, abortSignal) => {
      handlers = callbacks; signal = abortSignal!; return first.promise;
    });
    renderChat();
    expect(await screen.findByText('History 1')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Course 1/), { target: { value: 'Question A' } });
    fireEvent.click(screen.getByRole('button', { name: '➤' }));
    expect(screen.getByText('Question A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go B' }));
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText('History 2')).toBeTruthy();
    expect(screen.queryByText('Question A')).toBeNull();
    await act(async () => {
      handlers.accepted(message(1, 51, 'Accepted A'));
      handlers.stage('persisting');
      handlers.complete(message(1, 52, 'Answer A', 'agent'));
      first.reject(new Error('A failed late'));
      await first.promise.catch(() => undefined);
    });
    expect(screen.queryByText('Accepted A')).toBeNull();
    expect(screen.queryByText('Answer A')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry previous question' })).toBeNull();
    expect((screen.getByPlaceholderText(/Course 2/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('Ready');
  });

  it('ignores an A load that completes after navigating to B', async () => {
    const oldSession = deferred<ReturnType<typeof session>>();
    vi.mocked(chatAPI.getSession).mockImplementation(id => id === 1 ? oldSession.promise : Promise.resolve(session(id)));
    vi.mocked(chatAPI.getMessages).mockImplementation(async id => messages(id));
    renderChat();
    fireEvent.click(screen.getByRole('button', { name: 'Go B' }));
    expect(await screen.findByText('History 2')).toBeTruthy();
    await act(async () => { oldSession.resolve(session(1)); await oldSession.promise; });
    expect(screen.getByText('History 2')).toBeTruthy();
    expect(screen.queryByText('History 1')).toBeNull();
    expect(vi.mocked(chatAPI.getMessages)).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
  });

  it('ignores A messages that complete after B loads', async () => {
    const oldMessages = deferred<ReturnType<typeof messages>>();
    vi.mocked(chatAPI.getSession).mockImplementation(async id => session(id));
    vi.mocked(chatAPI.getMessages).mockImplementation(id => id === 1 ? oldMessages.promise : Promise.resolve(messages(id)));
    renderChat();
    await waitFor(() => expect(chatAPI.getMessages).toHaveBeenCalledWith(1, undefined, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: 'Go B' }));
    expect(await screen.findByText('History 2')).toBeTruthy();
    await act(async () => { oldMessages.resolve(messages(1)); await oldMessages.promise; });
    expect(screen.queryByText('History 1')).toBeNull();
  });
});
