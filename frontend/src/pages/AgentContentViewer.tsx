import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { chatAPI } from '../services/api';
import { useToast } from '../components/Toast';
import MessageMetadata from '../components/MessageMetadata';
import './AgentContentViewer.css';

interface ContentDetails {
  id: number;
  content_type: string;
  title: string;
  content: string;
  course_name: string;
  agent_name: string;
  generated_at: string;
  content_metadata: any;
}

const AgentContentViewer: React.FC = () => {
  const { contentId } = useParams<{ contentId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [content, setContent] = useState<ContentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadContent();
  }, [contentId]);

  const loadContent = async () => {
    try {
      setLoading(true);
      // Get all content and find the specific one
      const response = await chatAPI.getGeneratedContent({ isSaved: true });
      const foundContent = response.data.content.find(
        (c: ContentDetails) => c.id === parseInt(contentId!)
      );

      if (!foundContent) {
        showToast('Content not found', 'error');
        navigate('/ai-agent-hub');
        return;
      }

      setContent(foundContent);
    } catch (error: any) {
      console.error('Error loading content:', error);
      showToast(error.response?.data?.error || 'Failed to load content', 'error');
      navigate('/ai-agent-hub');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!content || !window.confirm('Are you sure you want to delete this content?')) {
      return;
    }

    try {
      setDeleting(true);
      await chatAPI.deleteGeneratedContent(content.id);
      showToast('Content deleted successfully', 'success');
      navigate('/ai-agent-hub');
    } catch (error: any) {
      console.error('Error deleting content:', error);
      showToast(error.response?.data?.error || 'Failed to delete content', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleCopyContent = () => {
    if (content) {
      navigator.clipboard.writeText(content.content);
      showToast('Content copied to clipboard', 'success');
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const getContentTypeLabel = (type: string) => {
    const labels: { [key: string]: string } = {
      summary: 'Summary',
      practice_questions: 'Practice Questions',
      explanation: 'Explanation',
      study_guide: 'Study Guide',
      quiz: 'Quiz',
      notes: 'Notes',
      other: 'Other'
    };
    return labels[type] || type;
  };

  const getContentTypeIcon = (type: string) => {
    const icons: { [key: string]: string } = {
      summary: '📝',
      practice_questions: '❓',
      explanation: '💡',
      study_guide: '📚',
      quiz: '✅',
      notes: '📋',
      other: '📄'
    };
    return icons[type] || '📄';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading) {
    return (
      <div className="content-viewer">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Loading content...</p>
        </div>
      </div>
    );
  }

  if (!content) {
    return null;
  }

  return (
    <div className="content-viewer">
      <div className="viewer-header">
        <div className="header-left">
          <button className="back-button" onClick={() => navigate('/ai-agent-hub')}>
            ← Back to AI Hub
          </button>
        </div>
        <div className="header-actions">
          <button className="action-btn copy-btn" onClick={handleCopyContent} title="Copy to clipboard">
            📋 Copy
          </button>
          <button className="action-btn print-btn" onClick={handlePrint} title="Print">
            🖨️ Print
          </button>
          <button
            className="action-btn delete-btn"
            onClick={handleDelete}
            disabled={deleting}
            title="Delete content"
          >
            🗑️ {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="viewer-container">
        <div className="content-header">
          <div className="content-type-badge">
            <span className="type-icon">{getContentTypeIcon(content.content_type)}</span>
            <span className="type-label">{getContentTypeLabel(content.content_type)}</span>
          </div>
          <h1 className="content-title">{content.title || 'Untitled Content'}</h1>
          <div className="content-meta">
            <div className="meta-item">
              <span className="meta-icon">📚</span>
              <span className="meta-text">{content.course_name}</span>
            </div>
            <div className="meta-item">
              <span className="meta-icon">🤖</span>
              <span className="meta-text">{content.agent_name}</span>
            </div>
            <div className="meta-item">
              <span className="meta-icon">📅</span>
              <span className="meta-text">{formatDate(content.generated_at)}</span>
            </div>
          </div>
        </div>

        <div className="content-body">
          <div className="content-text">
            {content.content.split('\n').map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </div>

        {Number.isSafeInteger(content.content_metadata?.originalMessageId) && (
          <MessageMetadata messageId={content.content_metadata.originalMessageId} savedContentId={content.id} metadata={content.content_metadata} />
        )}
      </div>
    </div>
  );
};

export default AgentContentViewer;
