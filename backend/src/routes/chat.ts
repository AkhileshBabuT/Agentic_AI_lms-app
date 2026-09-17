import express, { Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate, authorize, requireActiveStatus } from '../middleware/auth';
import {
  validateChatMessage,
  validateSessionStatus,
  validatePagination
} from '../middleware/validation';
import { createRateLimitMiddleware } from '../utils/rateLimiter';
import { answerCourseQuestion, persistCourseAnswer } from '../services/rag/CourseAnswerService';
import { assertCourseAccess } from '../services/rag/access';
import { getAuthorizedAnswerSources, getAuthorizedAnswerRecord, getAuthorizedSavedAnswerRecord } from '../services/rag/CitationService';
import { RAG_CONFIG } from '../config/rag';
import { logUsage } from '../utils/usageLogger';

function positiveId(value: string): number | null {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function respondToAnswerError(res: Response, error: unknown): void {
  const candidate = error as { status?: number; statusCode?: number; name?: string };
  const status = candidate?.status ?? candidate?.statusCode;
  if (status === 400) {
    res.status(400).json({ error: 'The question is empty or exceeds the course assistant input limit.' });
  } else if (status === 409) {
    res.status(409).json({ error: 'Course materials changed while answering. Please try again.' });
  } else if (status === 403 || status === 404) {
    res.status(status).json({ error: 'Access to this course or source is unavailable' });
  } else if (status === 429) {
    res.status(429).json({ error: 'The course assistant is busy. Please try again shortly.' });
  } else {
    // Do not return provider bodies, prompts, credentials, or database details.
    console.error('Course answer request failed', { type: candidate?.name ?? 'Error' });
    res.status(503).json({ error: 'The course assistant is temporarily unavailable. Please try again.' });
  }
}

/** Metadata from the retired scoring pipeline is not returned to course chat clients. */
function withoutScores(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const { confidence, trustScore, trust_score, validation_score, factCheck, fact_check,
    emotionalFilter, sources, ...rest } = metadata;
  return rest;
}

const router = express.Router();

// Apply middleware to all routes
router.use(authenticate);
router.use(authorize('student', 'professor', 'root'));
router.use(requireActiveStatus);

// Apply rate limiting to chat routes (100 requests per minute per user)
router.use(createRateLimitMiddleware(100, 60000));

// Get all courses for chatbot selection (based on user role)
router.get('/courses', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const userRole = req.user?.role;

    if (!userId || !userRole) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let result;

    if (userRole === 'student') {
      // Students: Get enrolled courses
      result = await pool.query(
        `SELECT
          c.id,
          c.title,
          c.description,
          u.full_name as instructor_name,
          e.enrolled_at,
          COUNT(DISTINCT cs.id) as session_count,
          MAX(cs.last_activity_at) as last_chat_activity
        FROM courses c
        INNER JOIN enrollments e ON c.id = e.course_id
        LEFT JOIN users u ON c.instructor_id = u.id
        LEFT JOIN chat_sessions cs ON c.id = cs.course_id AND cs.student_id = $1 AND cs.status = 'active'
        WHERE e.user_id = $1
        GROUP BY c.id, c.title, c.description, u.full_name, e.enrolled_at
        ORDER BY last_chat_activity DESC NULLS LAST, e.enrolled_at DESC`,
        [userId]
      );
    } else if (userRole === 'professor') {
      // Professors: Get courses they teach
      result = await pool.query(
        `SELECT
          c.id,
          c.title,
          c.description,
          u.full_name as instructor_name,
          ci.assigned_at,
          COUNT(DISTINCT cs.id) as session_count,
          MAX(cs.last_activity_at) as last_chat_activity
        FROM courses c
        LEFT JOIN course_instructors ci ON c.id = ci.course_id AND ci.user_id = $1
        LEFT JOIN users u ON c.instructor_id = u.id
        LEFT JOIN chat_sessions cs ON c.id = cs.course_id AND cs.student_id = $1 AND cs.status = 'active'
        WHERE ci.user_id = $1 OR c.instructor_id = $1
        GROUP BY c.id, c.title, c.description, u.full_name, ci.assigned_at
        ORDER BY last_chat_activity DESC NULLS LAST, ci.assigned_at DESC`,
        [userId]
      );
    } else if (userRole === 'root') {
      // Root: Get all courses
      result = await pool.query(
        `SELECT
          c.id,
          c.title,
          c.description,
          u.full_name as instructor_name,
          c.created_at,
          COUNT(DISTINCT cs.id) as session_count,
          MAX(cs.last_activity_at) as last_chat_activity
        FROM courses c
        LEFT JOIN users u ON c.instructor_id = u.id
        LEFT JOIN chat_sessions cs ON c.id = cs.course_id AND cs.student_id = $1 AND cs.status = 'active'
        GROUP BY c.id, c.title, c.description, u.full_name, c.created_at
        ORDER BY last_chat_activity DESC NULLS LAST, c.created_at DESC`,
        [userId]
      );
    }

    res.json({
      message: 'Courses retrieved successfully',
      courses: result?.rows || []
    });
  } catch (error) {
    console.error('Error fetching courses for chat:', error);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

// Get or create a chat session for a course
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const userRole = req.user?.role;
    const courseId = positiveId(String(req.body.courseId));

    if (!userId || !userRole) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    await assertCourseAccess({ courseId, userId, role: userRole });

    // Get or create agent based on user role
    const agentType = userRole === 'professor' ? 'instructor_assistant' :
      userRole === 'root' ? 'admin_assistant' : 'course_assistant';

    let agentResult = await pool.query(
      'SELECT id FROM chat_agents WHERE agent_type = $1 AND is_active = true LIMIT 1',
      [agentType]
    );

    let agentId;
    if (agentResult.rows.length === 0) {
      // Create role-specific agent
      let agentName, agentDescription, systemPrompt;

      if (userRole === 'professor') {
        agentName = 'Instructor Assistant';
        agentDescription = 'AI assistant to help with course management, assignment creation, and student engagement.';
        systemPrompt = 'You are an AI assistant for course instructors. Help with creating assignments, grading strategies, student engagement, and course content organization.';
      } else if (userRole === 'root') {
        agentName = 'Admin Assistant';
        agentDescription = 'AI assistant for system administration, analytics, and platform management.';
        systemPrompt = 'You are an AI assistant for LMS administrators. Help with user management, system analytics, course oversight, and platform optimization.';
      } else {
        agentName = 'Course Assistant';
        agentDescription = 'Your AI-powered course assistant ready to help with questions, explanations, and study materials.';
        systemPrompt = 'You are a helpful AI assistant for students. Provide clear, educational responses based on course materials.';
      }

      const newAgent = await pool.query(
        `INSERT INTO chat_agents (name, description, agent_type, system_prompt)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [agentName, agentDescription, agentType, systemPrompt]
      );
      agentId = newAgent.rows[0].id;
    } else {
      agentId = agentResult.rows[0].id;
    }

    // Check for existing active session
    const existingSession = await pool.query(
      `SELECT cs.*, c.title as course_name, ca.name as agent_name, ca.description as agent_description
       FROM chat_sessions cs
       JOIN courses c ON cs.course_id = c.id
       JOIN chat_agents ca ON cs.agent_id = ca.id
       WHERE cs.student_id = $1 AND cs.course_id = $2 AND cs.status = 'active'
       ORDER BY cs.last_activity_at DESC
       LIMIT 1`,
      [userId, courseId]
    );

    if (existingSession.rows.length > 0) {
      return res.json({
        message: 'Active session retrieved',
        session: existingSession.rows[0]
      });
    }

    // Create new session
    const courseResult = await pool.query('SELECT title FROM courses WHERE id = $1', [courseId]);
    const courseName = courseResult.rows[0]?.title || 'Course';

    const newSession = await pool.query(
      `INSERT INTO chat_sessions (student_id, agent_id, course_id, session_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, agentId, courseId, `${courseName} Chat`]
    );

    const sessionId = newSession.rows[0].id;

    // Add welcome message
    await pool.query(
      `INSERT INTO chat_messages (session_id, sender_type, content, message_metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        sessionId,
        'system',
        `Welcome to ${courseName}! I'm your AI assistant. Feel free to ask me anything about your course materials, assignments, or concepts you'd like to understand better.`,
        JSON.stringify({ type: 'welcome' })
      ]
    );

    // Get complete session data
    const completeSession = await pool.query(
      `SELECT cs.*, c.title as course_name, ca.name as agent_name, ca.description as agent_description
       FROM chat_sessions cs
       JOIN courses c ON cs.course_id = c.id
       JOIN chat_agents ca ON cs.agent_id = ca.id
       WHERE cs.id = $1`,
      [sessionId]
    );

    res.json({
      message: 'Chat session created successfully',
      session: completeSession.rows[0]
    });
  } catch (error) {
    respondToAnswerError(res, error);
  }
});

// Get all chat sessions for a student
router.get('/sessions', validateSessionStatus(), validatePagination(), async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { courseId, status = 'active' } = req.query;

    // FIXED: Use safe query building with validated parameters
    const baseQuery = `
      SELECT
        cs.*,
        c.title as course_name,
        ca.name as agent_name,
        ca.description as agent_description,
        (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) as message_count,
        (SELECT content FROM chat_messages WHERE session_id = cs.id AND sender_type = 'student'
         AND is_deleted = false ORDER BY created_at DESC,id DESC LIMIT 1) as last_message
      FROM chat_sessions cs
      JOIN courses c ON cs.course_id = c.id
      JOIN chat_agents ca ON cs.agent_id = ca.id
      WHERE cs.student_id = $1
    `;

    const params: any[] = [userId];
    const conditions: string[] = [];

    // Validate and add courseId filter
    if (courseId) {
      const parsedCourseId = parseInt(courseId as string, 10);
      if (!isNaN(parsedCourseId) && parsedCourseId > 0) {
        params.push(parsedCourseId);
        conditions.push(`cs.course_id = $${params.length}`);
      }
    }

    // Validate and add status filter (already validated by middleware)
    if (status) {
      params.push(status);
      conditions.push(`cs.status = $${params.length}`);
    }

    // Build final query safely
    const whereClause = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
    const finalQuery = baseQuery + whereClause + ' ORDER BY cs.last_activity_at DESC';

    const result = await pool.query(finalQuery, params);

    const accessibleSessions = [];
    for (const session of result.rows) {
      try {
        await assertCourseAccess({ courseId: session.course_id, userId, role: req.user!.role });
        accessibleSessions.push(session);
      } catch (error) {
        if ((error as { status?: number }).status !== 403) throw error;
      }
    }
    res.json({
      message: 'Chat sessions retrieved successfully',
      sessions: accessibleSessions
    });
  } catch (error) {
    console.error('Error fetching chat sessions:', error);
    res.status(500).json({ error: 'Failed to fetch chat sessions' });
  }
});

// Get messages for a specific chat session
router.get('/sessions/:sessionId/messages', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const sessionId = positiveId(req.params.sessionId);
    const limit = Number(req.query.limit ?? 50), offset = Number(req.query.offset ?? 0);
    if (!sessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'Invalid session ID or pagination' });
    }

    // Verify session belongs to user
    const sessionCheck = await pool.query(
      "SELECT id,course_id FROM chat_sessions WHERE id = $1 AND student_id = $2 AND status <> 'deleted'",
      [sessionId, userId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this chat session' });
    }

    await assertCourseAccess({ courseId: sessionCheck.rows[0].course_id, userId,
      role: req.user!.role });

    const result = await pool.query(
      `SELECT * FROM (SELECT * FROM chat_messages
       WHERE session_id = $1 AND is_deleted = false
       ORDER BY created_at DESC,id DESC
       LIMIT $2 OFFSET $3) recent ORDER BY created_at ASC,id ASC`,
      [sessionId, limit, offset]
    );

    const messages = await Promise.all(result.rows.map(async row => {
      const metadata = withoutScores(row.message_metadata || {});
      if (row.sender_type !== 'agent') return { ...row, message_metadata: metadata };
      const record = await getAuthorizedAnswerRecord(row.id, userId, req.user!.role);
      return { ...row,
        content: record.restricted ? 'This answer is unavailable because its supporting material is no longer accessible.' : row.content,
        sources: record.sources,
        message_metadata: { ...metadata, sources: record.sources,
          ...(record.restricted ? { answerStatus: 'source_unavailable' } : {}) } };
    }));
    res.json({
      message: 'Messages retrieved successfully',
      messages
    });
  } catch (error) {
    respondToAnswerError(res, error);
  }
});

// Generate only from currently authorized, published evidence.
router.post('/sessions/:sessionId/messages', createRateLimitMiddleware(40, 60000),
  validateChatMessage(), async (req: Request, res: Response) => {
    const user = req.user!;
    const sessionId = positiveId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    if (req.body.sanitizedContent.length > RAG_CONFIG.QUESTION_MAX_CHARS) {
      return res.status(400).json({ error: 'The question exceeds the course assistant input limit.' });
    }
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const session = await pool.query(
        `SELECT course_id FROM chat_sessions WHERE id=$1 AND student_id=$2 AND status='active'`,
        [sessionId, user.userId]);
      if (!session.rows.length) return res.status(403).json({ error: 'Access denied or session is not active' });
      const courseId = session.rows[0].course_id;
      await assertCourseAccess({ courseId, userId: user.userId, role: user.role });
      const studentMessage = await pool.query(
        `INSERT INTO chat_messages(session_id,sender_type,content) VALUES($1,'student',$2) RETURNING *`,
        [sessionId, req.body.sanitizedContent]);
      const answer = await answerCourseQuestion({ courseId, userId: user.userId, role: user.role,
        question: req.body.sanitizedContent, signal: controller.signal });
      if (controller.signal.aborted) return;
      const agentMessage = await persistCourseAnswer({ sessionId, courseId, userId: user.userId,
        role: user.role, answer, questionMessageId: studentMessage.rows[0].id });
      logUsage({ userId: user.userId, actionType: 'llm_request',
        endpoint: `/api/chat/sessions/${sessionId}/messages`, method: 'POST', statusCode: 200,
        metadata: { courseId, sessionId, messageId: agentMessage.id, answerStatus: answer.status,
          sourcesCount: answer.sources.length } });
      res.json({ message: 'Message sent successfully', studentMessage: studentMessage.rows[0],
        agentMessage: { ...agentMessage, sources: answer.sources } });
    } catch (error) {
      if (!controller.signal.aborted) respondToAnswerError(res, error);
    } finally {
      res.off('close', onClose);
    }
  });

// Archive a chat session
router.patch('/sessions/:sessionId/archive', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { sessionId } = req.params;

    const result = await pool.query(
      `UPDATE chat_sessions
       SET status = 'archived', ended_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND student_id = $2 AND status = 'active'
       RETURNING *`,
      [sessionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Active session not found' });
    }

    res.json({
      message: 'Session archived successfully',
      session: result.rows[0]
    });
  } catch (error) {
    console.error('Error archiving session:', error);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

// Get generated content for a student
router.get('/generated-content', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { courseId, contentType, isSaved } = req.query;

    let query = `
      SELECT
        agc.*,
        c.title as course_name,
        ca.name as agent_name
      FROM agent_generated_content agc
      JOIN courses c ON agc.course_id = c.id
      JOIN chat_agents ca ON agc.agent_id = ca.id
      WHERE agc.student_id = $1
    `;

    const params: any[] = [userId];
    let paramIndex = 2;

    if (courseId) {
      query += ` AND agc.course_id = $${paramIndex}`;
      params.push(courseId);
      paramIndex++;
    }

    if (contentType) {
      query += ` AND agc.content_type = $${paramIndex}`;
      params.push(contentType);
      paramIndex++;
    }

    if (isSaved !== undefined) {
      query += ` AND agc.is_saved = $${paramIndex}`;
      params.push(isSaved === 'true');
      paramIndex++;
    }

    query += ' ORDER BY agc.generated_at DESC';

    const result = await pool.query(query, params);

    const savedContent = [];
    for (const row of result.rows) {
      try { await assertCourseAccess({ courseId: row.course_id, userId, role: req.user!.role }); }
      catch (error) { if ((error as { status?: number }).status === 403) continue; throw error; }
      const metadata = withoutScores(row.content_metadata || {});
      const originalId = Number(metadata.originalMessageId);
      if (Number.isSafeInteger(originalId) && originalId > 0) {
        try {
          const record = await getAuthorizedSavedAnswerRecord(originalId, userId, req.user!.role);
          savedContent.push({ ...row,
            content: record.restricted ? 'This saved answer is unavailable because its supporting source is no longer accessible.' : row.content,
            content_metadata: { ...metadata, sources: record.sources } });
        } catch (error) {
          if ((error as { status?: number }).status !== 403) throw error;
          savedContent.push({ ...row, content: 'This saved answer is no longer available.',
            content_metadata: { ...metadata, sources: [], answerStatus: 'source_unavailable' } });
        }
      } else savedContent.push({ ...row, content_metadata: metadata });
    }
    res.json({ message: 'Generated content retrieved successfully', content: savedContent });
  } catch (error) {
    console.error('Error fetching generated content:', error);
    res.status(500).json({ error: 'Failed to fetch generated content' });
  }
});

// Save generated content
router.post('/generated-content', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { sessionId, contentType, title, content, metadata } = req.body;

    if (!sessionId || !contentType || !content) {
      return res.status(400).json({ error: 'Session ID, content type, and content are required' });
    }

    // Verify session belongs to user
    const sessionCheck = await pool.query(
      'SELECT course_id, agent_id FROM chat_sessions WHERE id = $1 AND student_id = $2',
      [sessionId, userId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this session' });
    }

    const { course_id, agent_id } = sessionCheck.rows[0];
    await assertCourseAccess({ courseId: course_id, userId, role: req.user!.role });

    let savedText = content;
    let savedMetadata = withoutScores(metadata || {});
    if (metadata?.originalMessageId !== undefined) {
      const originalId = positiveId(String(metadata.originalMessageId));
      if (!originalId) return res.status(400).json({ error: 'Invalid original answer ID' });
      const original = await pool.query(`SELECT content,message_metadata FROM chat_messages
        WHERE id=$1 AND session_id=$2 AND sender_type='agent' AND is_deleted=false`, [originalId, sessionId]);
      if (!original.rows.length) return res.status(403).json({ error: 'The original answer is unavailable' });
      const record = await getAuthorizedAnswerRecord(originalId, userId, req.user!.role);
      if (record.restricted) return res.status(409).json({ error: 'Supporting course material is no longer accessible' });
      savedText = original.rows[0].content;
      savedMetadata = { ...withoutScores(original.rows[0].message_metadata || {}),
        originalMessageId: originalId, sources: record.sources };
    }

    const result = await pool.query(
      `INSERT INTO agent_generated_content
       (agent_id, student_id, course_id, session_id, content_type, title, content, content_metadata, is_saved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [agent_id, userId, course_id, sessionId, contentType, title, savedText, JSON.stringify(savedMetadata), true]
    );

    res.json({
      message: 'Content saved successfully',
      generatedContent: result.rows[0]
    });
  } catch (error) {
    console.error('Error saving generated content:', error);
    res.status(500).json({ error: 'Failed to save generated content' });
  }
});

// Delete generated content
router.delete('/generated-content/:contentId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { contentId } = req.params;

    const result = await pool.query(
      'DELETE FROM agent_generated_content WHERE id = $1 AND student_id = $2 RETURNING id',
      [contentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json({ message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting generated content:', error);
    res.status(500).json({ error: 'Failed to delete content' });
  }
});

// Preserve the old answer unless the replacement and its citations commit successfully.
router.post('/sessions/:sessionId/regenerate', createRateLimitMiddleware(40, 60000),
  async (req: Request, res: Response) => {
    const user = req.user!;
    const sessionId = positiveId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const session = await pool.query(
        `SELECT course_id FROM chat_sessions WHERE id=$1 AND student_id=$2 AND status='active'`,
        [sessionId, user.userId]);
      if (!session.rows.length) return res.status(403).json({ error: 'Access denied or session is not active' });
      const courseId = session.rows[0].course_id;
      await assertCourseAccess({ courseId, userId: user.userId, role: user.role });
      const lastQuestion = await pool.query(
        `SELECT id,content FROM chat_messages WHERE session_id=$1 AND sender_type='student'
         AND is_deleted=false ORDER BY created_at DESC,id DESC LIMIT 1`, [sessionId]);
      if (!lastQuestion.rows.length) return res.status(400).json({ error: 'No student messages found' });
      const previous = await pool.query(
        `SELECT id FROM chat_messages WHERE session_id=$1 AND sender_type='agent'
         AND is_deleted=false AND id>$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [sessionId, lastQuestion.rows[0].id]);
      const answer = await answerCourseQuestion({ courseId, userId: user.userId, role: user.role,
        question: lastQuestion.rows[0].content, signal: controller.signal });
      if (controller.signal.aborted) return;
      const agentMessage = await persistCourseAnswer({ sessionId, courseId, userId: user.userId,
        role: user.role, answer, regeneratedFrom: previous.rows[0]?.id,
        questionMessageId: lastQuestion.rows[0].id, isRegeneration: true });
      res.json({ message: 'Response regenerated successfully',
        agentMessage: { ...agentMessage, sources: answer.sources } });
    } catch (error) {
      if (!controller.signal.aborted) respondToAnswerError(res, error);
    } finally { res.off('close', onClose); }
  });

// Compatibility endpoints: scoring is retired and never triggers a model request.
router.get('/messages/:messageId/trust-score', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Answer scoring has been retired. Use document references.' });
});
router.get('/messages/:messageId/fact-check', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Answer scoring has been retired. Use document references.' });
});

router.get('/messages/:messageId/sources', async (req: Request, res: Response) => {
  const messageId = positiveId(req.params.messageId);
  if (!messageId) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const sources = await getAuthorizedAnswerSources({ messageId, userId: req.user!.userId,
      role: req.user!.role });
    res.json({ message: 'Sources retrieved successfully', sources });
  } catch (error) { respondToAnswerError(res, error); }
});

export default router;
