import express, { Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';
import { GradingAssistantAgent } from '../services/agents/GradingAssistantAgent';
import {
  validateRequired,
  validatePositiveInteger,
  validateRubricCriteria,
  validatePoints
} from '../middleware/validation';
import { logUsage } from '../utils/usageLogger';

const router = express.Router();

// Rubrics are private to assigned instructors, including the course owner.
const instructorAccess = `(c.instructor_id = $2 OR EXISTS (
  SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.user_id = $2
))`;


/**
 * @route   POST /api/grading-assistant/generate-tentative-grade
 * @desc    Generate tentative grade for a submission
 * @access  Private (Student - auto-generated on submission)
 */
router.post('/generate-tentative-grade',
  authenticate,
  validateRequired('submissionId'),
  validatePositiveInteger('submissionId', 'body'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { submissionId } = req.body;
    const userId = req.user!.userId;

    // Get submission details
    const submissionResult = await pool.query(
      `SELECT sub.*, a.id as assignment_id, a.title, a.description, a.question_text, a.points,
              sf.file_name
       FROM assignment_submissions sub
       JOIN assignments a ON sub.assignment_id = a.id
       LEFT JOIN submission_files sf ON sub.id = sf.submission_id
       WHERE sub.id = $1 AND sub.student_id = $2`,
      [submissionId, userId]
    );

    if (submissionResult.rows.length === 0) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }

    const submission = submissionResult.rows[0];
    const files = submissionResult.rows.map(row => row.file_name).filter(Boolean);

    // Get grading rubric
    const rubricResult = await pool.query(
      'SELECT * FROM grading_rubrics WHERE assignment_id = $1',
      [submission.assignment_id]
    );

    if (rubricResult.rows.length === 0) {
      res.status(400).json({ error: 'No grading rubric found for this assignment' });
      return;
    }

    const rubric = {
      id: rubricResult.rows[0].id,
      assignment_id: rubricResult.rows[0].assignment_id,
      rubric_name: rubricResult.rows[0].rubric_name,
      criteria: rubricResult.rows[0].criteria,
      total_points: rubricResult.rows[0].total_points
    };

    // Generate tentative grade
    const gradingAgent = new GradingAssistantAgent();
    const tentativeGrade = await gradingAgent.generateTentativeGrade(
      submissionId,
      submission.assignment_id,
      userId,
      submission.submission_text || '',
      files,
      rubric
    );

    // Log grading LLM usage
    logUsage({
      userId,
      actionType: 'grading_request',
      endpoint: '/api/grading-assistant/generate-tentative-grade',
      method: 'POST',
      statusCode: 200,
      metadata: {
        submissionId,
        assignmentId: submission.assignment_id,
        assignmentTitle: submission.title,
      },
    });

    res.status(200).json({
      success: true,
      tentativeGrade
    });

  } catch (error: any) {
    console.error('Error generating tentative grade:', error);
    res.status(500).json({ error: error.message || 'Failed to generate tentative grade' });
  }
});

/**
 * @route   GET /api/grading-assistant/tentative-grade/:submissionId
 * @desc    Get tentative grade for a submission
 * @access  Private (Student or Professor)
 */
router.get('/tentative-grade/:submissionId', authenticate, validatePositiveInteger('submissionId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { submissionId } = req.params;
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    // A student may read only their own submission; an instructor may read only
    // submissions for a course they own or have been assigned to teach.
    if (userRole !== 'student' && userRole !== 'professor') {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const submissionCheck = await pool.query(
      `SELECT sub.id FROM assignment_submissions sub
       JOIN assignments a ON a.id = sub.assignment_id
       JOIN courses c ON c.id = a.course_id
       WHERE sub.id = $1 AND (
         ($3 = 'student' AND sub.student_id = $2)
         OR ($3 = 'professor' AND ${instructorAccess})
       )`,
      [submissionId, userId, userRole]
    );
    if (submissionCheck.rows.length === 0) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Get tentative grade
    const result = await pool.query(
      'SELECT * FROM tentative_grades WHERE submission_id = $1',
      [submissionId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No tentative grade found' });
      return;
    }

    res.status(200).json({
      success: true,
      tentativeGrade: result.rows[0]
    });

  } catch (error: any) {
    console.error('Error fetching tentative grade:', error);
    res.status(500).json({ error: 'Failed to fetch tentative grade' });
  }
});

/**
 * @route   POST /api/grading-assistant/finalize-grade/:tentativeGradeId
 * @desc    Finalize a tentative grade (Professor only)
 * @access  Private (Professor)
 */
router.post('/finalize-grade/:tentativeGradeId', authenticate,
  validatePositiveInteger('tentativeGradeId'),
  async (req: Request, res: Response): Promise<void> => {
  const { tentativeGradeId } = req.params;
  const { finalGrade, feedback } = req.body;
  const userId = req.user!.userId;

  if (req.user!.role !== 'professor') {
    res.status(403).json({ error: 'Only professors can finalize grades' });
    return;
  }
  if (!Number.isInteger(finalGrade) || finalGrade < 0 || typeof feedback !== 'string') {
    res.status(400).json({ error: 'Invalid grade or feedback' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock both rows before changing either grade. Course scope is checked on
    // the actual submission, not on denormalized tentative-grade columns.
    const tentativeResult = await client.query(
      `SELECT tg.id, sub.id AS submission_id, a.points
       FROM tentative_grades tg
       JOIN assignment_submissions sub ON sub.id = tg.submission_id
       JOIN assignments a ON a.id = sub.assignment_id
       JOIN courses c ON c.id = a.course_id
       WHERE tg.id = $1 AND ${instructorAccess}
       FOR UPDATE OF tg, sub`,
      [tentativeGradeId, userId]
    );
    if (tentativeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Tentative grade not found' });
      return;
    }
    const tentativeGrade = tentativeResult.rows[0];
    if (finalGrade > tentativeGrade.points) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Grade exceeds assignment points' });
      return;
    }

    await client.query(
      `UPDATE assignment_submissions
       SET grade = $1, feedback = $2, graded_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [finalGrade, feedback, tentativeGrade.submission_id]
    );
    await client.query(
      `UPDATE tentative_grades
       SET is_final = true, finalized_at = CURRENT_TIMESTAMP, finalized_by = $1
       WHERE id = $2`,
      [userId, tentativeGradeId]
    );
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Grade finalized successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error finalizing grade:', error);
    res.status(500).json({ error: 'Failed to finalize grade' });
  } finally {
    client.release();
  }
});

/**
 * @route   POST /api/grading-assistant/create-rubric
 * @desc    Create a grading rubric for an assignment (Professor only)
 * @access  Private (Professor)
 */
router.post('/create-rubric',
  authenticate,
  validateRequired('assignmentId', 'rubricName', 'criteria', 'totalPoints'),
  validatePositiveInteger('assignmentId', 'body'),
  validateRubricCriteria(),
  validatePoints('totalPoints', 10000),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { assignmentId, rubricName, criteria, totalPoints } = req.body;
    const userId = req.user!.userId;
    const userRole = req.user!.role;

    if (userRole !== 'professor') {
      res.status(403).json({ error: 'Only professors can create rubrics' });
      return;
    }

    const assignmentResult = await pool.query(
      `SELECT a.course_id
       FROM assignments a
       JOIN courses c ON a.course_id = c.id
       WHERE a.id = $1 AND ${instructorAccess}`,
      [assignmentId, userId]
    );

    if (assignmentResult.rows.length === 0) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const courseId = assignmentResult.rows[0].course_id;

    // Create rubric
    const result = await pool.query(
      `INSERT INTO grading_rubrics (assignment_id, course_id, rubric_name, criteria, total_points, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [assignmentId, courseId, rubricName, JSON.stringify(criteria), totalPoints, userId]
    );

    res.status(201).json({
      success: true,
      rubric: result.rows[0]
    });

  } catch (error: any) {
    console.error('Error creating rubric:', error);
    res.status(500).json({ error: 'Failed to create rubric' });
  }
});

/**
 * @route   GET /api/grading-assistant/rubric/:assignmentId
 * @desc    Get rubric for an assignment
 * @access  Private (Professor assigned to course)
 */
router.get('/rubric/:assignmentId', authenticate,
  validatePositiveInteger('assignmentId'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { assignmentId } = req.params;
    if (req.user!.role !== 'professor') {
      res.status(403).json({ error: 'Only professors can view rubrics' });
      return;
    }

    const result = await pool.query(
      `SELECT r.* FROM grading_rubrics r
       JOIN assignments a ON a.id = r.assignment_id
       JOIN courses c ON c.id = a.course_id
       WHERE a.id = $1 AND ${instructorAccess}`,
      [assignmentId, req.user!.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No rubric found for this assignment' });
      return;
    }

    res.status(200).json({ success: true, rubric: result.rows[0] });
  } catch (error) {
    console.error('Error fetching rubric:', error);
    res.status(500).json({ error: 'Failed to fetch rubric' });
  }
});

export default router;
