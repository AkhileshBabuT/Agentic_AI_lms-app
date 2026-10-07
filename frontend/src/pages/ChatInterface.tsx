import React, { useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { chatAPI } from '../services/api';
import { submitChatStream, ChatStreamError } from '../services/chatStream';
import type { StreamMessage } from '../services/chatStream';
import { useToast } from '../components/Toast';
import MessageMetadata from '../components/MessageMetadata';
import { httpErrorMessage } from '../utils/httpError';
import './ChatInterface.css';

type Message = StreamMessage;

interface Session {
  id: number;
  course_name: string;
  agent_name: string;
  agent_description: string;
  session_name: string;
  status: string;
}

const ChatInterface: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [agentStatus, setAgentStatus] = useState<'ready' | 'thinking' | 'active'>('ready');
  const [stageLabel, setStageLabel] = useState('');
  const [pendingRetry, setPendingRetry] = useState<{ content: string; key: string } | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [selectedMessageToSave, setSelectedMessageToSave] = useState<Message | null>(null);
  const [saveContentType, setSaveContentType] = useState('notes');
  const [saveContentTitle, setSaveContentTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamController = useRef<AbortController | null>(null);
  const route = useMemo(() => ({ sessionId }), [sessionId]);
  const activeRoute = useRef<typeof route | null>(null);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);

  useLayoutEffect(() => {
    activeRoute.current = route;
    setSession(null);
    setMessages([]);
    setInputMessage('');
    setLoading(true);
    setLoadedSessionId(null);
    setSending(false);
    setAgentStatus('ready');
    setStageLabel('');
    setPendingRetry(null);
    setShowSaveModal(false);
    setSelectedMessageToSave(null);
    setSaveContentTitle('');
    setSaveContentType('notes');
    setSaving(false);
    return () => {
      activeRoute.current = null;
      streamController.current?.abort();
      streamController.current = null;
    };
  }, [route]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const isCurrent = () => activeRoute.current === route && !controller.signal.aborted;
    const loadChatData = async () => {
      try {
        // Load the requested session directly, including sessions beyond the first list page.
        const sessionResponse = await chatAPI.getSession(parseInt(sessionId), controller.signal);
        if (!isCurrent()) return;
        const currentSession = sessionResponse.data.session as Session;
        if (!currentSession) {
          showToast('Chat session not found', 'error');
          navigate('/ai-agent-hub');
          return;
        }

        const messagesResponse = await chatAPI.getMessages(parseInt(sessionId), undefined, controller.signal);
        if (!isCurrent()) return;
        setSession(currentSession);
        setMessages(messagesResponse.data.messages);
      } catch (error: unknown) {
        if (!isCurrent()) return;
        showToast(httpErrorMessage(error, 'Failed to load chat'), 'error');
        navigate('/ai-agent-hub');
      } finally {
        if (isCurrent()) {
          setLoadedSessionId(sessionId);
          setLoading(false);
        }
      }
    };
    void loadChatData();
    return () => controller.abort();
  }, [navigate, route, sessionId, showToast]);

  const sendStream = async (messageContent: string, requestKey: string, optimisticId?: number) => {
    if (!sessionId) return;
    setSending(true);
    setAgentStatus('thinking');
    setStageLabel('Connecting to the course assistant...');
    const controller = new AbortController();
    const requestRoute = route;
    const isCurrent = () => activeRoute.current === requestRoute;
    streamController.current = controller;
    let accepted = false;
    try {
      await submitChatStream(parseInt(sessionId), messageContent, requestKey, {
        accepted: studentMessage => {
          if (!isCurrent() || controller.signal.aborted) return;
          accepted = true;
          setMessages(prev => {
            const withoutLocal = optimisticId === undefined ? prev : prev.filter(message => message.id !== optimisticId);
            return withoutLocal.some(message => message.id === studentMessage.id)
              ? withoutLocal : [...withoutLocal, studentMessage];
          });
        },
        stage: stage => {
          if (!isCurrent() || controller.signal.aborted) return;
          const labels: Record<string, string> = {
            searching_materials: 'Searching course materials...',
            generating_answer: 'Drafting an answer...',
            validating_citations: 'Checking document references...',
            persisting: 'Saving the verified answer...',
          };
          setStageLabel(labels[stage] || 'Working on your answer...');
        },
        complete: agentMessage => {
          if (!isCurrent() || controller.signal.aborted) return;
          setMessages(prev => prev.some(message => message.id === agentMessage.id)
            ? prev : [...prev, agentMessage]);
          setPendingRetry(null);
        },
      }, controller.signal);
      if (isCurrent()) setAgentStatus('ready');
    } catch (error) {
      if (!isCurrent()) return;
      if (optimisticId !== undefined && !accepted)
        setMessages(prev => prev.filter(message => message.id !== optimisticId));
      setPendingRetry({ content: messageContent, key: requestKey });
      if (!accepted) setInputMessage(messageContent);
      const failure = error as ChatStreamError;
      showToast(controller.signal.aborted ? 'Answer cancelled. You can retry the same question.'
        : failure.message || 'The answer could not be completed. You can retry.', 'error');
      setAgentStatus('ready');
    } finally {
      if (isCurrent()) {
        setStageLabel('');
        setSending(false);
        inputRef.current?.focus();
      }
      if (streamController.current === controller) streamController.current = null;
    }
  };

  const handleSendMessage = () => {
    if (!inputMessage.trim() || sending || streamController.current || !sessionId) return;
    const content = inputMessage.trim();
    const key = crypto.randomUUID();
    const optimisticId = -Date.now();
    setPendingRetry(null);
    setInputMessage('');
    setMessages(prev => [...prev, { id: optimisticId, session_id: parseInt(sessionId),
      sender_type: 'student', content, message_metadata: {}, created_at: new Date().toISOString() }]);
    void sendStream(content, key, optimisticId);
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleRegenerateResponse = async () => {
    if (!sessionId || sending) return;
    const requestRoute = route;
    const isCurrent = () => activeRoute.current === requestRoute;

    setSending(true);
    setAgentStatus('thinking');

    try {
      const response = await chatAPI.regenerateResponse(parseInt(sessionId));
      if (!isCurrent()) return;

      // Remove last agent message and add new one
      setMessages(prev => {
        const filtered = prev.filter(
          (msg, idx) => !(msg.sender_type === 'agent' && idx === prev.length - 1)
        );
        return [...filtered, response.data.agentMessage];
      });

      showToast('Response regenerated', 'success');
      setAgentStatus('ready');
    } catch (error: unknown) {
      if (!isCurrent()) return;
      console.error('Error regenerating response:', error);
      showToast(httpErrorMessage(error, 'Failed to regenerate response'), 'error');
      setAgentStatus('ready');
    } finally {
      if (isCurrent()) setSending(false);
    }
  };

  const handleCopyMessage = (content: string) => {
    navigator.clipboard.writeText(content);
    showToast('Message copied to clipboard', 'success');
  };

  const handleArchiveSession = async () => {
    if (!sessionId) return;
    const requestRoute = route;
    const isCurrent = () => activeRoute.current === requestRoute;

    try {
      await chatAPI.archiveSession(parseInt(sessionId));
      if (!isCurrent()) return;
      showToast('Chat archived successfully', 'success');
      navigate('/ai-agent-hub');
    } catch (error: unknown) {
      if (!isCurrent()) return;
      console.error('Error archiving session:', error);
      showToast(httpErrorMessage(error, 'Failed to archive chat'), 'error');
    }
  };

  const handleSaveContent = (message: Message) => {
    setSelectedMessageToSave(message);
    setSaveContentTitle('');
    setSaveContentType('notes');
    setShowSaveModal(true);
  };

  const handleSaveContentSubmit = async () => {
    if (!selectedMessageToSave || !sessionId || !saveContentTitle.trim()) {
      showToast('Please provide a title for the content', 'error');
      return;
    }

    const requestRoute = route;
    const isCurrent = () => activeRoute.current === requestRoute;
    try {
      setSaving(true);
      await chatAPI.saveGeneratedContent({
        sessionId: parseInt(sessionId),
        contentType: saveContentType,
        title: saveContentTitle.trim(),
        content: selectedMessageToSave.content,
        metadata: {
          originalMessageId: selectedMessageToSave.id,
          savedAt: new Date().toISOString()
        }
      });
      if (!isCurrent()) return;

      showToast('Content saved successfully', 'success');
      setShowSaveModal(false);
      setSelectedMessageToSave(null);
    } catch (error: unknown) {
      if (!isCurrent()) return;
      console.error('Error saving content:', error);
      showToast(httpErrorMessage(error, 'Failed to save content'), 'error');
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  const handleCloseSaveModal = () => {
    setShowSaveModal(false);
    setSelectedMessageToSave(null);
    setSaveContentTitle('');
    setSaveContentType('notes');
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString();
  };

  const groupMessagesByDate = () => {
    const grouped: { [key: string]: Message[] } = {};

    messages.forEach(msg => {
      const dateKey = formatDate(msg.created_at);
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey].push(msg);
    });

    return grouped;
  };

  const suggestionChips = [
    'Explain this concept',
    'Create practice questions',
    'Summarize this chapter',
    'Help with assignment'
  ];

  const handleSuggestionClick = (suggestion: string) => {
    setInputMessage(suggestion);
    inputRef.current?.focus();
  };

  const getAgentStatusColor = () => {
    switch (agentStatus) {
      case 'thinking': return '#ffa500';
      case 'active': return '#4caf50';
      default: return '#4caf50';
    }
  };

  const getAgentStatusText = () => {
    switch (agentStatus) {
      case 'thinking': return stageLabel || 'Working on your answer...';
      case 'active': return 'Active';
      default: return 'Ready';
    }
  };

  if (loading || loadedSessionId !== sessionId) {
    return (
      <div className="chat-interface">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Loading chat...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  const groupedMessages = groupMessagesByDate();

  return (
    <div className="chat-interface">
      {/* Chat Header */}
      <div className="chat-header">
        <div className="header-left">
          <button className="back-button" onClick={() => navigate('/ai-agent-hub')}>
            ← Back
          </button>
          <div className="header-info">
            <h2>{session.course_name}</h2>
            <div className="breadcrumb">
              Dashboard &gt; AI Agent Hub &gt; {session.course_name} &gt; Chat
            </div>
          </div>
        </div>
        <div className="header-right">
          <div className="agent-status">
            <span
              className="status-indicator"
              style={{ backgroundColor: getAgentStatusColor() }}
            ></span>
            <span className="status-text" role="status" aria-live="polite">{getAgentStatusText()}</span>
          </div>
          <div className="header-actions">
            <button className="action-button" title="Clear conversation" onClick={handleArchiveSession}>
              🗑️
            </button>
            <button className="action-button" title="Settings">
              ⚙️
            </button>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className="messages-container">
        <div className="messages-area">
          {Object.entries(groupedMessages).map(([date, msgs]) => (
            <div key={date} className="message-group">
              <div className="date-separator">
                <span>{date}</span>
              </div>
              {msgs.map((message) => (
                <div
                  key={message.id}
                  className={`message-wrapper ${message.sender_type}`}
                >
                  {message.sender_type === 'agent' && (
                    <div className="message-avatar">🤖</div>
                  )}
                  <div className={`message-bubble ${message.sender_type}`}>
                    {message.sender_type === 'system' ? (
                      <div className="system-message">{message.content}</div>
                    ) : (
                      <>
                        <div className="message-content">
                          {message.sender_type === 'agent' ? (
                            <ReactMarkdown>{message.content}</ReactMarkdown>
                          ) : (
                            message.content
                          )}
                        </div>

                        {/* Revalidated supporting document references */}
                        {message.sender_type === 'agent' && (
                          <MessageMetadata
                            messageId={message.id}
                            metadata={message.message_metadata}
                            authorizedSources={message.sources}
                          />
                        )}

                        <div className="message-footer">
                          <span className="message-time">
                            {formatTime(message.created_at)}
                          </span>
                          {message.sender_type === 'agent' && (
                            <div className="message-actions">
                              <button
                                className="icon-button"
                                onClick={() => handleCopyMessage(message.content)}
                                title="Copy"
                              >
                                📋
                              </button>
                              <button
                                className="icon-button"
                                onClick={() => handleSaveContent(message)}
                                title="Save content"
                              >
                                💾
                              </button>
                              {messages[messages.length - 1]?.id === message.id && (
                                <button
                                  className="icon-button"
                                  onClick={handleRegenerateResponse}
                                  title="Regenerate"
                                  disabled={sending}
                                >
                                  🔄
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {message.sender_type === 'student' && (
                    <div className="message-avatar student">👤</div>
                  )}
                </div>
              ))}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="input-container">
        {messages.length <= 1 && (
          <div className="suggestion-chips">
            {suggestionChips.map((chip, index) => (
              <button
                key={index}
                className="suggestion-chip"
                onClick={() => handleSuggestionClick(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        <div className="input-area">
          {pendingRetry && !sending && (
            <button type="button" className="suggestion-chip" onClick={() => {
              setInputMessage('');
              void sendStream(pendingRetry.content, pendingRetry.key);
            }}>Retry previous question</button>
          )}
          <textarea
            ref={inputRef}
            className="message-input"
            placeholder={`Ask me anything about ${session.course_name}...`}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            rows={1}
            maxLength={500}
            disabled={sending}
          />
          <div className="input-actions">
            <span className="char-counter">
              {inputMessage.length}/500
            </span>
            <button className="icon-button" title="Attach file" disabled>
              📎
            </button>
            <button
              className="send-button"
              onClick={handleSendMessage}
              disabled={!inputMessage.trim() || sending}
            >
              {sending ? '...' : '➤'}
            </button>
            {sending && <button type="button" className="suggestion-chip"
              onClick={() => streamController.current?.abort()}>Cancel answer</button>}
          </div>
        </div>
      </div>

      {/* Save Content Modal */}
      {showSaveModal && (
        <div className="modal-overlay" onClick={handleCloseSaveModal}>
          <div className="save-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>💾 Save Content</h2>
              <button className="close-modal-btn" onClick={handleCloseSaveModal}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="content-title">Title *</label>
                <input
                  id="content-title"
                  type="text"
                  className="form-input"
                  placeholder="Enter a title for this content"
                  value={saveContentTitle}
                  onChange={(e) => setSaveContentTitle(e.target.value)}
                  maxLength={100}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="content-type">Content Type</label>
                <select
                  id="content-type"
                  className="form-select"
                  value={saveContentType}
                  onChange={(e) => setSaveContentType(e.target.value)}
                >
                  <option value="notes">Notes</option>
                  <option value="summary">Summary</option>
                  <option value="practice_questions">Practice Questions</option>
                  <option value="explanation">Explanation</option>
                  <option value="study_guide">Study Guide</option>
                  <option value="quiz">Quiz</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="form-group">
                <label>Preview</label>
                <div className="content-preview">
                  {selectedMessageToSave?.content.substring(0, 200)}
                  {selectedMessageToSave && selectedMessageToSave.content.length > 200 ? '...' : ''}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={handleCloseSaveModal} disabled={saving}>
                Cancel
              </button>
              <button
                className="save-btn"
                onClick={handleSaveContentSubmit}
                disabled={!saveContentTitle.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Content'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatInterface;
