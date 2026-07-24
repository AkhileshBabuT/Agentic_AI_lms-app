import express, { Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate, authorize, requireActiveStatus } from '../middleware/auth';
import {
  validateChatMessage,
  validateSessionStatus,
  validateContentType,
  validatePositiveInteger,
  validatePagination
} from '../middleware/validation';
import { createRateLimitMiddleware } from '../utils/rateLimiter';
import { SubjectChatbotAgent } from '../services/agents/SubjectChatbotAgent';
import { EnhancedIntegrityVerificationAgent } from '../services/agents/EnhancedIntegrityVerificationAgent';
import { AgentMessage } from '../services/agents/newAgentTypes';
import { AIContext, AIMessage } from '../services/ai/types';
import { getGroqFactCheckService } from '../services/factcheck/GroqFactCheckService';
import { getSourceOfTruthMode } from '../services/settingsService';
import { FACT_CHECK_CONFIG } from '../config/constants';
import { logUsage } from '../utils/usageLogger';
import fs from 'fs';
import path from 'path';

// File-only logging (no console output)
const LOG_PATH = path.join(__dirname, '../../api-debug.log');
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${timestamp}] ${message}\n`);
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
        INNER JOIN course_instructors ci ON c.id = ci.course_id
        LEFT JOIN users u ON c.instructor_id = u.id
        LEFT JOIN chat_sessions cs ON c.id = cs.course_id AND cs.student_id = $1 AND cs.status = 'active'
        WHERE ci.user_id = $1
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
    const { courseId } = req.body;

    if (!userId || !userRole) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    // Verify course access based on role
    let hasAccess = false;

    if (userRole === 'student') {
      const enrollmentCheck = await pool.query(
        'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
        [userId, courseId]
      );
      hasAccess = enrollmentCheck.rows.length > 0;
    } else if (userRole === 'professor') {
      const instructorCheck = await pool.query(
        'SELECT id FROM course_instructors WHERE user_id = $1 AND course_id = $2',
        [userId, courseId]
      );
      hasAccess = instructorCheck.rows.length > 0;
    } else if (userRole === 'root') {
      const courseCheck = await pool.query(
        'SELECT id FROM courses WHERE id = $1',
        [courseId]
      );
      hasAccess = courseCheck.rows.length > 0;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this course' });
    }

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
    console.error('Error creating chat session:', error);
    res.status(500).json({ error: 'Failed to create chat session' });
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
        (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at DESC LIMIT 1) as last_message
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

    res.json({
      message: 'Chat sessions retrieved successfully',
      sessions: result.rows
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
    const { sessionId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    // Verify session belongs to user
    const sessionCheck = await pool.query(
      'SELECT id FROM chat_sessions WHERE id = $1 AND student_id = $2',
      [sessionId, userId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this chat session' });
    }

    const result = await pool.query(
      `SELECT * FROM chat_messages
       WHERE session_id = $1 AND is_deleted = false
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [sessionId, limit, offset]
    );

    res.json({
      message: 'Messages retrieved successfully',
      messages: result.rows
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a message in a chat session (with stricter rate limit for AI calls)
router.post(
  '/sessions/:sessionId/messages',
  createRateLimitMiddleware(40, 60000), // 40 AI messages per minute (accounts for metadata polling)
  validateChatMessage(),
  async (req: Request, res: Response) => {
    try {
      logToFile('\n' + '='.repeat(80));
      logToFile('📨 NEW MESSAGE RECEIVED');
      logToFile('Session ID: ' + req.params.sessionId);
      logToFile('Message: ' + req.body.content?.substring(0, 100));
      logToFile('='.repeat(80));

      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { sessionId } = req.params;
      const { sanitizedContent } = req.body;  // Use sanitized content from validation middleware

      // Validate session ID
      const parsedSessionId = parseInt(sessionId, 10);
      if (isNaN(parsedSessionId) || parsedSessionId <= 0) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      // Verify session belongs to user
      const sessionCheck = await pool.query(
        'SELECT course_id FROM chat_sessions WHERE id = $1 AND student_id = $2 AND status = $3',
        [parsedSessionId, userId, 'active']
      );

      if (sessionCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied or session is not active' });
      }

      const courseId = sessionCheck.rows[0].course_id;

      // Save student message with sanitized content
      const studentMessage = await pool.query(
        `INSERT INTO chat_messages (session_id, sender_type, content)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [parsedSessionId, 'student', sanitizedContent]
      );

      // Get recent message history for context
      const historyResult = await pool.query(
        `SELECT sender_type, content FROM chat_messages
       WHERE session_id = $1 AND is_deleted = false
       ORDER BY created_at ASC
       LIMIT 20`,
        [parsedSessionId]
      );

      // Get course details
      const courseResult = await pool.query(
        'SELECT id, title, description FROM courses WHERE id = $1',
        [courseId]
      );
      const course = courseResult.rows[0];

      // Build AI context from conversation history
      const conversationHistory: AIMessage[] = historyResult.rows.map(row => ({
        role: (row.sender_type === 'student' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: row.content
      }));

      const aiContext: AIContext = {
        conversationHistory,
        courseMetadata: {
          id: course.id,
          title: course.title,
          description: course.description
        }
      };

      // Create agent message for the Subject Chatbot
      const agentMessage: AgentMessage = {
        content: sanitizedContent,  // Use sanitized content
        userId,
        role: 'student',
        sessionId: parsedSessionId,
        messageId: studentMessage.rows[0].id,
        timestamp: new Date()
      };

      // Generate AI response using Subject Chatbot Agent
      const chatbot = new SubjectChatbotAgent();
      const agentResponse = await chatbot.execute(agentMessage, aiContext);

      // Save AI response with metadata
      const agentMessageResult = await pool.query(
        `INSERT INTO chat_messages (session_id, sender_type, content, message_metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [parsedSessionId, 'agent', agentResponse.content, JSON.stringify({
          confidence: agentResponse.confidence,
          sourcesCount: agentResponse.sources?.length || 0,
          emotionalFilter: agentResponse.metadata?.emotionalFilter || null,
          sourceOfTruthMode: agentResponse.metadata?.sourceOfTruthMode || null
        })]
      );

      const savedAgentMessageId = agentMessageResult.rows[0].id;

      // Log LLM usage
      logUsage({
        userId,
        actionType: 'llm_request',
        endpoint: `/api/chat/sessions/${parsedSessionId}/messages`,
        method: 'POST',
        statusCode: 200,
        metadata: {
          sessionId: parsedSessionId,
          courseId,
          messageId: savedAgentMessageId,
          confidence: agentResponse.confidence,
          sourcesCount: agentResponse.sources?.length || 0,
          responseLength: agentResponse.content.length,
        },
      });

      // Run ENHANCED Integrity Verification Agent in background with proper error handling
      // This will independently verify sources with web crawling and calculate trust score
      logToFile('='.repeat(80));
      logToFile('🔍 PREPARING TO START VERIFICATION');
      logToFile('Message ID: ' + savedAgentMessageId);
      logToFile('Course ID: ' + courseId);
      logToFile('Response length: ' + agentResponse.content.length);
      logToFile('Sources count: ' + (agentResponse.sources?.length || 0));
      logToFile('Sources: ' + JSON.stringify(agentResponse.sources, null, 2));
      logToFile('='.repeat(80));

      // FIXED: Improved error handling for background verification
      (async () => {
        const MAX_RETRIES = 2;
        let attempt = 0;

        while (attempt <= MAX_RETRIES) {
          try {
            const verifier = new EnhancedIntegrityVerificationAgent();
            logToFile(`✓ Verifier instance created (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);

            await verifier.verifyResponse(
              savedAgentMessageId,
              agentResponse.content,
              agentResponse.sources || [],
              courseId
            );

            logToFile('✅ Verification completed successfully');
            break;  // Success, exit retry loop

          } catch (err: any) {
            attempt++;
            logToFile(`❌ ERROR IN ENHANCED INTEGRITY VERIFICATION (attempt ${attempt}/${MAX_RETRIES + 1}):`);
            logToFile('Error message: ' + err.message);
            logToFile('Error stack: ' + err.stack);

            if (attempt > MAX_RETRIES) {
              // Store error state in database using correct schema columns
              try {
                await pool.query(
                  `INSERT INTO message_trust_scores (
                    message_id, trust_score, trust_level, verification_reasoning,
                    source_verification_details, conflicts_detected
                  ) VALUES ($1, $2, $3, $4, $5, $6)
                  ON CONFLICT (message_id) DO UPDATE SET
                    trust_score = EXCLUDED.trust_score,
                    trust_level = EXCLUDED.trust_level,
                    verification_reasoning = EXCLUDED.verification_reasoning,
                    source_verification_details = EXCLUDED.source_verification_details,
                    conflicts_detected = EXCLUDED.conflicts_detected,
                    verification_timestamp = CURRENT_TIMESTAMP`,
                  [
                    savedAgentMessageId,
                    0,
                    'low',
                    `Verification failed after ${MAX_RETRIES + 1} attempts: ${err.message}`,
                    JSON.stringify({
                      verification_details: [],
                      evidence_summary: `Verification error after ${MAX_RETRIES + 1} attempts.`,
                      error: err.message,
                      timestamp: new Date().toISOString()
                    }),
                    ['Verification system encountered an error']
                  ]
                );
                logToFile('⚠️ Verification failed after retries, error state recorded in database');
              } catch (dbErr: any) {
                logToFile('❌ Failed to record verification error in database: ' + dbErr.message);
              }
            } else {
              // Wait before retry (exponential backoff)
              const waitTime = Math.pow(2, attempt) * 1000;
              logToFile(`⏳ Waiting ${waitTime}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
            }
          }
        }
      })();

      // Run Groq fact-check in background (INDEPENDENT of Gemini verification)
      (async () => {
        try {
          const factChecker = getGroqFactCheckService();
          if (factChecker.isEnabled()) {
            // Fetch actual source content to give Groq real evidence for fact-checking
            let sourceContent: Array<{ fileName: string; content: string }> = [];
            try {
              const sourceResult = await pool.query(
                `SELECT cm.file_name, cmc.content_text
                 FROM course_material_content cmc
                 JOIN course_materials cm ON cmc.material_id = cm.id
                 WHERE cm.course_id = $1 AND cmc.content_text IS NOT NULL
                 ORDER BY cmc.last_indexed_at DESC
                 LIMIT 5`,
                [courseId]
              );
              sourceContent = sourceResult.rows.map(row => ({
                fileName: row.file_name,
                content: row.content_text.substring(0, FACT_CHECK_CONFIG.MAX_SOURCE_CHARS)
              }));
            } catch (srcErr: any) {
              logToFile(`⚠️ Could not fetch source content for fact-check: ${srcErr.message}`);
            }

            await factChecker.factCheck(
              savedAgentMessageId,
              agentResponse.content,
              sanitizedContent,
              conversationHistory,
              { title: course.title, description: course.description },
              sourceContent,
              await getSourceOfTruthMode()
            );
          }
        } catch (err: any) {
          logToFile('Fact-check error (non-blocking): ' + err.message);
        }
      })();

      // Update session last activity
      await pool.query(
        'UPDATE chat_sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1',
        [parsedSessionId]
      );

      res.json({
        message: 'Message sent successfully',
        studentMessage: studentMessage.rows[0],
        agentMessage: {
          ...agentMessageResult.rows[0],
          sources: agentResponse.sources,
          confidence: agentResponse.confidence
        }
      });
    } catch (error: any) {
      console.error('❌ ERROR SENDING MESSAGE:');
      console.error('Error type:', error.constructor.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('Full error:', error);

      // Return more detailed error for debugging
      const errorMessage = error.message || 'Failed to send message';
      res.status(500).json({
        error: 'Failed to send message',
        details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
      });
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

    res.json({
      message: 'Generated content retrieved successfully',
      content: result.rows
    });
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

    const result = await pool.query(
      `INSERT INTO agent_generated_content
       (agent_id, student_id, course_id, session_id, content_type, title, content, content_metadata, is_saved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [agent_id, userId, course_id, sessionId, contentType, title, content, JSON.stringify(metadata || {}), true]
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

// Regenerate last AI response
router.post('/sessions/:sessionId/regenerate', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { sessionId } = req.params;

    // Verify session belongs to user
    const sessionCheck = await pool.query(
      'SELECT course_id FROM chat_sessions WHERE id = $1 AND student_id = $2 AND status = $3',
      [sessionId, userId, 'active']
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied or session is not active' });
    }

    const courseId = sessionCheck.rows[0].course_id;

    // Get the last student message
    const lastStudentMessage = await pool.query(
      `SELECT content FROM chat_messages
       WHERE session_id = $1 AND sender_type = 'student' AND is_deleted = false
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId]
    );

    if (lastStudentMessage.rows.length === 0) {
      return res.status(400).json({ error: 'No student messages found' });
    }

    // Mark the last agent message as deleted
    await pool.query(
      `UPDATE chat_messages
       SET is_deleted = true
       WHERE session_id = $1 AND sender_type = 'agent' AND is_deleted = false
       AND id = (
         SELECT id FROM chat_messages
         WHERE session_id = $1 AND sender_type = 'agent' AND is_deleted = false
         ORDER BY created_at DESC
         LIMIT 1
       )`,
      [sessionId]
    );

    // Get message history
    const historyResult = await pool.query(
      `SELECT sender_type, content FROM chat_messages
       WHERE session_id = $1 AND is_deleted = false
       ORDER BY created_at ASC
       LIMIT 20`,
      [sessionId]
    );

    // Get course details
    const courseResult = await pool.query(
      'SELECT id, title, description FROM courses WHERE id = $1',
      [courseId]
    );
    const course = courseResult.rows[0];

    // Build AI context
    const conversationHistory: AIMessage[] = historyResult.rows.map(row => ({
      role: (row.sender_type === 'student' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: row.content
    }));

    const aiContext: AIContext = {
      conversationHistory,
      courseMetadata: {
        id: course.id,
        title: course.title,
        description: course.description
      }
    };

    // Create agent message
    const agentMessage: AgentMessage = {
      content: lastStudentMessage.rows[0].content,
      userId,
      role: 'student',
      sessionId: parseInt(sessionId),
      timestamp: new Date()
    };

    // Generate new AI response using Subject Chatbot
    const chatbot = new SubjectChatbotAgent();
    const agentResponse = await chatbot.execute(agentMessage, aiContext);

    // Save new AI response
    const newAgentMessageResult = await pool.query(
      `INSERT INTO chat_messages (session_id, sender_type, content, message_metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [sessionId, 'agent', agentResponse.content, JSON.stringify({
        regenerated: true,
        confidence: agentResponse.confidence,
        sourcesCount: agentResponse.sources?.length || 0,
        sourceOfTruthMode: agentResponse.metadata?.sourceOfTruthMode || null
      })]
    );

    const savedAgentMessageId = newAgentMessageResult.rows[0].id;

    // Log LLM usage for regeneration
    logUsage({
      userId,
      actionType: 'llm_request',
      endpoint: `/api/chat/sessions/${sessionId}/regenerate`,
      method: 'POST',
      statusCode: 200,
      metadata: {
        sessionId: parseInt(sessionId),
        courseId,
        messageId: savedAgentMessageId,
        regenerated: true,
        confidence: agentResponse.confidence,
        sourcesCount: agentResponse.sources?.length || 0,
      },
    });

    // Run ENHANCED Integrity Verification in background
    const verifier = new EnhancedIntegrityVerificationAgent();
    verifier.verifyResponse(
      savedAgentMessageId,
      agentResponse.content,
      agentResponse.sources || [],
      courseId
    ).catch(err => {
      console.error('Error in enhanced integrity verification:', err);
    });

    res.json({
      message: 'Response regenerated successfully',
      agentMessage: {
        ...newAgentMessageResult.rows[0],
        sources: agentResponse.sources,
        confidence: agentResponse.confidence
      }
    });
  } catch (error) {
    console.error('Error regenerating response:', error);
    res.status(500).json({ error: 'Failed to regenerate response' });
  }
});

// Get trust score for a message
router.get('/messages/:messageId/trust-score', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { messageId } = req.params;

    // Verify user has access to this message
    const messageCheck = await pool.query(
      `SELECT cm.id
       FROM chat_messages cm
       JOIN chat_sessions cs ON cm.session_id = cs.id
       WHERE cm.id = $1 AND cs.student_id = $2`,
      [messageId, userId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this message' });
    }

    // Get trust score
    const trustScoreResult = await pool.query(
      'SELECT * FROM message_trust_scores WHERE message_id = $1',
      [messageId]
    );

    if (trustScoreResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trust score not yet calculated' });
    }

    const trustRow = trustScoreResult.rows[0];

    res.json({
      message: 'Trust score retrieved successfully',
      trustScore: {
        ...trustRow,
        // New validation / verifier-disagreement fields (nullable for older messages).
        // Snake_case to match the existing sibling keys (trust_score, trust_level, ...)
        validation_score: trustRow.validation_score ?? null,
        validation_min_sentence_score: trustRow.validation_min_sentence_score ?? null,
        verifiers_disagree: trustRow.verifiers_disagree ?? null,
        low_validation_warning: trustRow.low_validation_warning ?? null
      }
    });
  } catch (error) {
    console.error('Error fetching trust score:', error);
    res.status(500).json({ error: 'Failed to fetch trust score' });
  }
});

// Get fact-check result for a message (Groq independent verification)
router.get('/messages/:messageId/fact-check', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { messageId } = req.params;

    // Verify user has access to this message
    const messageCheck = await pool.query(
      `SELECT cm.id
       FROM chat_messages cm
       JOIN chat_sessions cs ON cm.session_id = cs.id
       WHERE cm.id = $1 AND cs.student_id = $2`,
      [messageId, userId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this message' });
    }

    // Get fact-check result
    const factCheckResult = await pool.query(
      'SELECT * FROM fact_check_results WHERE message_id = $1',
      [messageId]
    );

    if (factCheckResult.rows.length === 0) {
      return res.status(404).json({ error: 'Fact-check result not yet available' });
    }

    res.json({
      message: 'Fact-check result retrieved successfully',
      factCheck: factCheckResult.rows[0]
    });
  } catch (error) {
    console.error('Error fetching fact-check result:', error);
    res.status(500).json({ error: 'Failed to fetch fact-check result' });
  }
});

// Get sources for a message
router.get('/messages/:messageId/sources', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { messageId } = req.params;

    // Verify user has access to this message
    const messageCheck = await pool.query(
      `SELECT cm.id
       FROM chat_messages cm
       JOIN chat_sessions cs ON cm.session_id = cs.id
       WHERE cm.id = $1 AND cs.student_id = $2`,
      [messageId, userId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this message' });
    }

    // Get sources
    const sourcesResult = await pool.query(
      'SELECT * FROM response_sources WHERE message_id = $1 ORDER BY relevance_score DESC',
      [messageId]
    );

    res.json({
      message: 'Sources retrieved successfully',
      sources: sourcesResult.rows
    });
  } catch (error) {
    console.error('Error fetching sources:', error);
    res.status(500).json({ error: 'Failed to fetch sources' });
  }
});

export default router;
