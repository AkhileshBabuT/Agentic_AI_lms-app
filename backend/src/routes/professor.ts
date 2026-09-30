import express, { Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate, authorize, requireApprovedProfessor } from '../middleware/auth';
import { uploadCourseMaterials, uploadAssignmentFiles, handleMulterError } from '../middleware/upload';
import { uploadFile, deleteFile, generateSignedUrl, downloadFile } from '../config/storage';
import { queueMaterialUpload } from '../services/materials/ingestion';
import { MaterialValidationError } from '../services/materials/fileValidation';
import { retryMaterialIngestion } from '../services/materials/retryIngestion';
import { logUsage } from '../utils/usageLogger';
import { parseLimit, decodeCursor, encodeCursor, cursorFromRow } from '../utils/pagination';

const router = express.Router();

// Apply authentication and authorization to all professor routes
router.use(authenticate);
router.use(authorize('professor'));
router.use(requireApprovedProfessor);

// Get professor's assigned course
router.get('/course', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.created_at, c.updated_at,
              COUNT(DISTINCT e.id) as enrolled_students_count
       FROM course_instructors ci
       JOIN courses c ON ci.course_id = c.id
       LEFT JOIN enrollments e ON c.id = e.course_id
       WHERE ci.user_id = $1
       GROUP BY c.id`,
      [req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned',
        message: 'You are not assigned to any course yet'
      });
    }

    res.json({
      message: 'Course retrieved successfully',
      course: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching professor course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all students enrolled in professor's course
router.get('/students', async (req, res) => {
  try {
    let limit: number, cursor;
    const scope = `professor-students:${req.user!.userId}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }
    // First get the professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned',
        message: 'You are not assigned to any course yet'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Get all enrolled students
    const studentsResult = await pool.query(
      `SELECT u.id, u.full_name, u.full_name AS cursor_time, u.email, e.enrolled_at
       FROM enrollments e
       JOIN users u ON e.user_id = u.id
       WHERE e.course_id = $1 AND u.role = 'student'
       ${cursor ? 'AND (u.full_name,u.id) > ($2::text,$3::bigint)' : ''}
       ORDER BY u.full_name ASC,u.id ASC LIMIT $${cursor ? 4 : 2}`,
      cursor ? [courseId, cursor.at, cursor.id, limit + 1] : [courseId, limit + 1]
    );

    const hasMore = studentsResult.rows.length > limit;
    const students = studentsResult.rows.slice(0, limit);
    res.json({
      message: 'Students retrieved successfully',
      courseId: courseId,
      items: students, students,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(students[students.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching enrolled students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update course details
router.put('/course', async (req, res) => {
  try {
    const { title, description } = req.body;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned',
        message: 'You are not assigned to any course yet'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Update course
    const result = await pool.query(
      `UPDATE courses
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [title, description, courseId]
    );

    res.json({
      message: 'Course updated successfully',
      course: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all assignments for professor's course
router.get('/assignments', async (req, res) => {
  try {
    let limit: number, cursor;
    const scope = `professor-assignments:${req.user!.userId}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }
    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Get assignments
    const result = await pool.query(
      `SELECT id, title, description, question_text, due_date, points, created_at, updated_at,
              COALESCE(due_date,'epoch'::timestamp)::text AS cursor_time
       FROM assignments
       WHERE course_id = $1
       ${cursor ? "AND (COALESCE(due_date,'epoch'::timestamp),id) < ($2::timestamp,$3::bigint)" : ''}
       ORDER BY COALESCE(due_date,'epoch'::timestamp) DESC,id DESC LIMIT $${cursor ? 4 : 2}`,
      cursor ? [courseId, cursor.at, cursor.id, limit + 1] : [courseId, limit + 1]
    );

    const hasMore = result.rows.length > limit;
    const assignments = result.rows.slice(0, limit);
    res.json({
      message: 'Assignments retrieved successfully',
      courseId: courseId,
      items: assignments, assignments,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(assignments[assignments.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new assignment
router.post('/assignments', async (req, res) => {
  try {
    const { title, description, questionText, dueDate, points } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Assignment title is required' });
    }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Create assignment first
    const result = await pool.query(
      `INSERT INTO assignments (title, description, question_text, course_id, due_date, points)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, description || null, questionText || null, courseId, dueDate || null, points || 100]
    );

    const assignment = result.rows[0];

    // Extract AI grading criteria in background (don't wait for it)
    // This happens asynchronously so professor doesn't have to wait
    (async () => {
      try {
        const { assignmentCriteriaExtractor } = await import('../services/ai/AssignmentCriteriaExtractor');
        const criteria = await assignmentCriteriaExtractor.extractCriteria(
          title,
          description || '',
          questionText || '',
          points || 100
        );

        // Update assignment with extracted criteria
        await pool.query(
          'UPDATE assignments SET ai_grading_criteria = $1 WHERE id = $2',
          [JSON.stringify(criteria), assignment.id]
        );

        console.log(`✓ AI grading criteria extracted for assignment ${assignment.id}`);
      } catch (error) {
        console.error('Error extracting AI grading criteria:', error);
        // Don't fail the assignment creation if criteria extraction fails
      }
    })();

    res.status(201).json({
      message: 'Assignment created successfully',
      assignment: assignment
    });
  } catch (error) {
    console.error('Error creating assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update an assignment
router.put('/assignments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, questionText, dueDate, points } = req.body;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify assignment belongs to professor's course
    const assignmentCheck = await pool.query(
      'SELECT id FROM assignments WHERE id = $1 AND course_id = $2',
      [id, courseId]
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Assignment not found or does not belong to your course'
      });
    }

    // Update assignment
    const result = await pool.query(
      `UPDATE assignments
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           question_text = COALESCE($3, question_text),
           due_date = COALESCE($4, due_date),
           points = COALESCE($5, points),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [title, description, questionText, dueDate, points, id]
    );

    const updatedAssignment = result.rows[0];

    // Re-extract AI grading criteria if title, description, or question changed
    if (title || description || questionText || points) {
      (async () => {
        try {
          const { assignmentCriteriaExtractor } = await import('../services/ai/AssignmentCriteriaExtractor');
          const criteria = await assignmentCriteriaExtractor.extractCriteria(
            updatedAssignment.title,
            updatedAssignment.description || '',
            updatedAssignment.question_text || '',
            updatedAssignment.points || 100
          );

          await pool.query(
            'UPDATE assignments SET ai_grading_criteria = $1 WHERE id = $2',
            [JSON.stringify(criteria), id]
          );

          console.log(`✓ AI grading criteria re-extracted for assignment ${id}`);
        } catch (error) {
          console.error('Error re-extracting AI grading criteria:', error);
        }
      })();
    }

    res.json({
      message: 'Assignment updated successfully',
      assignment: updatedAssignment
    });
  } catch (error) {
    console.error('Error updating assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an assignment
router.delete('/assignments/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Delete assignment (must belong to professor's course)
    const result = await pool.query(
      'DELETE FROM assignments WHERE id = $1 AND course_id = $2 RETURNING id, title',
      [id, courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Assignment not found or does not belong to your course'
      });
    }

    res.json({
      message: 'Assignment deleted successfully',
      assignment: result.rows[0]
    });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all announcements for professor's course
router.get('/announcements', async (req, res) => {
  try {
    let limit: number, cursor;
    const scope = `professor-announcements:${req.user!.userId}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }
    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Get announcements
    const result = await pool.query(
      `SELECT a.id, a.title, a.content, a.created_at, a.updated_at,
              a.created_at::text AS cursor_time,
              u.full_name as author_name
       FROM announcements a
       JOIN users u ON a.author_id = u.id
       WHERE a.course_id = $1
       ${cursor ? 'AND (a.created_at,a.id) < ($2::timestamp,$3::bigint)' : ''}
       ORDER BY a.created_at DESC,a.id DESC LIMIT $${cursor ? 4 : 2}`,
      cursor ? [courseId, cursor.at, cursor.id, limit + 1] : [courseId, limit + 1]
    );

    const hasMore = result.rows.length > limit;
    const announcements = result.rows.slice(0, limit);
    res.json({
      message: 'Announcements retrieved successfully',
      courseId: courseId,
      items: announcements, announcements,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(announcements[announcements.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new announcement
router.post('/announcements', async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        error: 'Announcement title and content are required'
      });
    }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Create announcement
    const result = await pool.query(
      `INSERT INTO announcements (title, content, course_id, author_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, content, courseId, req.user!.userId]
    );

    res.status(201).json({
      message: 'Announcement created successfully',
      announcement: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update an announcement
router.put('/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify announcement belongs to professor's course
    const announcementCheck = await pool.query(
      'SELECT id FROM announcements WHERE id = $1 AND course_id = $2',
      [id, courseId]
    );

    if (announcementCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Announcement not found or does not belong to your course'
      });
    }

    // Update announcement
    const result = await pool.query(
      `UPDATE announcements
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [title, content, id]
    );

    res.json({
      message: 'Announcement updated successfully',
      announcement: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating announcement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an announcement
router.delete('/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No course assigned'
      });
    }

    const courseId = courseResult.rows[0].course_id;

    // Delete announcement (must belong to professor's course)
    const result = await pool.query(
      'DELETE FROM announcements WHERE id = $1 AND course_id = $2 RETURNING id, title',
      [id, courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Announcement not found or does not belong to your course'
      });
    }

    res.json({
      message: 'Announcement deleted successfully',
      announcement: result.rows[0]
    });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== COURSE MATERIALS ENDPOINTS ==========

// Upload course materials
router.post('/materials', uploadCourseMaterials, handleMulterError, async (req: Request, res: Response) => {
  let stage = 'course_access';
  try {
    const files = req.files as Express.Multer.File[];
    if (!files?.length) return res.status(400).json({error: 'No files uploaded'});
    const course = await pool.query('SELECT course_id FROM course_instructors WHERE user_id=$1', [req.user!.userId]);
    if (!course.rowCount) return res.status(404).json({error: 'No course assigned'});
    const courseId = course.rows[0].course_id;
    const folderId = req.body.folderId ? Number(req.body.folderId) : null;
    if (folderId !== null && (!Number.isInteger(folderId) || folderId <= 0)) return res.status(400).json({error: 'Invalid folder'});
    if (folderId) {
      const folder = await pool.query('SELECT id FROM material_folders WHERE id=$1 AND course_id=$2', [folderId, courseId]);
      if (!folder.rowCount) return res.status(404).json({error: 'Target folder not found'});
    }
    const materials = [];
    // No transaction remains open across GCS, parsing, or model execution.
    for (const file of files) {
      stage = 'attachment_registration';
      const material = await queueMaterialUpload({courseId, userId: req.user!.userId, folderId, file});
      materials.push(material);
      await logUsage({userId: req.user!.userId, actionType: 'file_upload', endpoint: '/api/professor/materials', method: 'POST', statusCode: 202,
        metadata: {materialId: material.id, fileSize: file.size, ingestionStatus: material.ingestion_status}});
    }
    return res.status(202).json({message: 'Attachments accepted; indexing runs in the background', materials});
  } catch (error) {
    if (error instanceof MaterialValidationError) {
      return res.status(400).json({ error: error.message, code: 'MATERIAL_VALIDATION_FAILED' });
    }
    const databaseCode = (error as { code?: unknown })?.code;
    console.error('Course material upload failed', {
      stage,
      databaseCode: typeof databaseCode === 'string' && /^[A-Z0-9]{5}$/.test(databaseCode) ? databaseCode : undefined,
    });
    return res.status(500).json({error: 'Could not accept the attachment; check material status before retrying'});
  }
});

// Get all course materials (optionally filtered by folder)
router.post('/materials/:id/reindex', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error: 'Invalid material'});
  try {
    const ingestionStatus = await retryMaterialIngestion(id, req.user!.userId);
    return res.status(202).json({message: 'Native indexing retry accepted; OCR remains disabled',ingestion_status: ingestionStatus});
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return res.status(message === 'Material not found' ? 404 : 409).json({error: message === 'Material not found' ? message : 'Stored original is unavailable for retry; inspect upload status'});
  }
});

router.get('/materials', async (req, res) => {
  try {
    let limit: number, cursor;
    // folderId param: undefined = all materials (backward compat), 'null'/'' = root only, number = specific folder
    const folderIdParam = req.query.folderId as string | undefined;
    const hasFolderFilter = folderIdParam !== undefined;
    const folderId = hasFolderFilter
      ? (folderIdParam === 'null' || folderIdParam === '' ? null : parseInt(folderIdParam))
      : undefined;
    const scope = `professor-materials:${req.user!.userId}:${folderIdParam ?? 'all'}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    let query: string;
    let params: any[];

    if (!hasFolderFilter) {
      // No folderId param = return ALL materials (backward compatible for chatbot/RAG)
      query = `
        SELECT cm.*, cm.uploaded_at::text AS cursor_time, u.full_name as uploader_name
        FROM course_materials cm
        JOIN users u ON cm.uploaded_by = u.id
        WHERE cm.course_id = $1 AND cm.deleted_at IS NULL
      `;
      params = [courseId];
    } else if (folderId === null) {
      // Root folder
      query = `
        SELECT cm.*, cm.uploaded_at::text AS cursor_time, u.full_name as uploader_name
        FROM course_materials cm
        JOIN users u ON cm.uploaded_by = u.id
        WHERE cm.course_id = $1 AND cm.deleted_at IS NULL AND cm.folder_id IS NULL
      `;
      params = [courseId];
    } else {
      // Specific folder
      const folderCheck = await pool.query(
        'SELECT id FROM material_folders WHERE id = $1 AND course_id = $2',
        [folderId, courseId]
      );
      if (folderCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      query = `
        SELECT cm.*, cm.uploaded_at::text AS cursor_time, u.full_name as uploader_name
        FROM course_materials cm
        JOIN users u ON cm.uploaded_by = u.id
        WHERE cm.course_id = $1 AND cm.deleted_at IS NULL AND cm.folder_id = $2
      `;
      params = [courseId, folderId];
    }

    if (cursor) {
      query += ` AND (cm.uploaded_at,cm.id) < ($${params.length + 1}::timestamp,$${params.length + 2}::bigint)`;
      params.push(cursor.at, cursor.id);
    }
    query += ` ORDER BY cm.uploaded_at DESC,cm.id DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1);
    const result = await pool.query(query, params);
    const hasMore = result.rows.length > limit;
    const materials = result.rows.slice(0, limit);

    res.json({
      message: 'Course materials retrieved successfully',
      items: materials, materials,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(materials[materials.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching course materials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete course material
router.delete('/materials/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    await client.query('BEGIN');

    // Get material details
    const materialResult = await client.query(
      'SELECT * FROM course_materials WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL',
      [id, courseId]
    );

    if (materialResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Material not found' });
    }

    const material = materialResult.rows[0];

    // Retain immutable attachment versions for audit; retrieval rechecks deletion.
    await client.query("UPDATE course_materials SET deleted_at=now(),visibility='deleted',ingestion_status='deleted' WHERE id=$1", [id]);

    await client.query('COMMIT');

    res.json({
      message: 'Course material deleted successfully',
      material: material
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting course material:', error);
    res.status(500).json({ error: 'Failed to delete course material' });
  } finally {
    client.release();
  }
});

// Get signed URL for course material download
router.get('/materials/:id/download', async (req, res) => {
  try {
    const { id } = req.params;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Get material
    const result = await pool.query(
      'SELECT * FROM course_materials WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL',
      [id, courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Material not found' });
    }

    const material = result.rows[0];

    // Generate signed URL (valid for 60 minutes)
    const signedUrl = await generateSignedUrl(material.file_path, 60);

    res.json({
      message: 'Download URL generated successfully',
      url: signedUrl,
      fileName: material.file_name
    });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ========== MATERIAL FOLDERS ENDPOINTS ==========

// Get folders for a given parent folder (or root if no folderId)
router.get('/folders', async (req, res) => {
  try {
    const folderIdParam = req.query.folderId;
    const folderId = folderIdParam === undefined ? null : Number(folderIdParam);
    if (folderIdParam !== undefined && (typeof folderId !== 'number' || !Number.isSafeInteger(folderId) || folderId < 1))
      return res.status(400).json({ error: 'Invalid folder ID' });
    let limit: number, cursor;
    const scope = `professor-folders:${req.user!.userId}:${folderId ?? 'root'}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    let query: string;
    let params: any[];

    if (folderId === null) {
      query = `
        SELECT mf.*, mf.name AS cursor_time, u.full_name as creator_name
        FROM material_folders mf
        JOIN users u ON mf.created_by = u.id
        WHERE mf.course_id = $1 AND mf.parent_id IS NULL
      `;
      params = [courseId];
    } else {
      // Verify the folder belongs to this course
      const folderCheck = await pool.query(
        'SELECT id FROM material_folders WHERE id = $1 AND course_id = $2',
        [folderId, courseId]
      );
      if (folderCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }

      query = `
        SELECT mf.*, mf.name AS cursor_time, u.full_name as creator_name
        FROM material_folders mf
        JOIN users u ON mf.created_by = u.id
        WHERE mf.course_id = $1 AND mf.parent_id = $2
      `;
      params = [courseId, folderId];
    }

    if (cursor) {
      query += ` AND (mf.name,mf.id) > ($${params.length + 1}::text,$${params.length + 2}::bigint)`;
      params.push(cursor.at, cursor.id);
    }
    query += ` ORDER BY mf.name ASC,mf.id ASC LIMIT $${params.length + 1}`;
    params.push(limit + 1);
    const foldersResult = await pool.query(query, params);
    const hasMore = foldersResult.rows.length > limit;
    const folders = foldersResult.rows.slice(0, limit);

    res.json({
      message: 'Folders retrieved successfully',
      items: folders, folders,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(folders[folders.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get folder breadcrumb (ancestors chain from root to current folder)
router.get('/folders/:id/breadcrumb', async (req, res) => {
  try {
    const { id } = req.params;

    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Use recursive CTE to get full path from root to this folder
    const result = await pool.query(`
      WITH RECURSIVE folder_path AS (
        SELECT id, name, parent_id, 1 as depth
        FROM material_folders
        WHERE id = $1 AND course_id = $2
        UNION ALL
        SELECT mf.id, mf.name, mf.parent_id, fp.depth + 1
        FROM material_folders mf
        JOIN folder_path fp ON mf.id = fp.parent_id
      )
      SELECT id, name, parent_id FROM folder_path ORDER BY depth DESC
    `, [id, courseId]);

    res.json({
      message: 'Breadcrumb retrieved successfully',
      breadcrumb: result.rows
    });
  } catch (error) {
    console.error('Error fetching breadcrumb:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new folder
router.post('/folders', async (req, res) => {
  try {
    const { name, parentId } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const sanitizedName = name.trim();
    if (sanitizedName.length > 255 || /[<>:"/\\|?*]/.test(sanitizedName)) {
      return res.status(400).json({
        error: 'Invalid folder name. Avoid special characters: < > : " / \\ | ? *'
      });
    }

    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // If parentId is provided, verify it belongs to this course
    if (parentId) {
      const parentCheck = await pool.query(
        'SELECT id FROM material_folders WHERE id = $1 AND course_id = $2',
        [parentId, courseId]
      );
      if (parentCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
    }

    const result = await pool.query(
      `INSERT INTO material_folders (course_id, parent_id, name, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [courseId, parentId || null, sanitizedName, req.user!.userId]
    );

    res.status(201).json({
      message: 'Folder created successfully',
      folder: result.rows[0]
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A folder with this name already exists in this location' });
    }
    console.error('Error creating folder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rename a folder
router.put('/folders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const sanitizedName = name.trim();
    if (sanitizedName.length > 255 || /[<>:"/\\|?*]/.test(sanitizedName)) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    const result = await pool.query(
      `UPDATE material_folders
       SET name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND course_id = $3
       RETURNING *`,
      [sanitizedName, id, courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    res.json({
      message: 'Folder renamed successfully',
      folder: result.rows[0]
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A folder with this name already exists in this location' });
    }
    console.error('Error renaming folder:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a folder and all its contents (cascade)
router.delete('/folders/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify folder belongs to this course
    const folderCheck = await pool.query(
      'SELECT id FROM material_folders WHERE id = $1 AND course_id = $2',
      [id, courseId]
    );

    if (folderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    await client.query('BEGIN');

    // Soft-delete descendants; keep source versions and citation provenance.
    const deletedMaterials = await client.query(`
      WITH RECURSIVE descendant_folders AS (
        SELECT id FROM material_folders WHERE id=$1
        UNION ALL SELECT mf.id FROM material_folders mf JOIN descendant_folders df ON mf.parent_id=df.id
      )
      UPDATE course_materials SET deleted_at=now(),visibility='deleted',ingestion_status='deleted',folder_id=NULL
      WHERE folder_id IN (SELECT id FROM descendant_folders) AND course_id=$2
    `, [id, courseId]);

    // 4. Delete the folder (CASCADE on parent_id FK handles subfolders)
    await client.query('DELETE FROM material_folders WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.json({
      message: 'Folder and all contents deleted successfully',
      deletedFiles: deletedMaterials.rowCount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting folder:', error);
    res.status(500).json({ error: 'Failed to delete folder' });
  } finally {
    client.release();
  }
});

// ========== ASSIGNMENT FILES ENDPOINTS ==========

// Upload files to an assignment
router.post('/assignments/:assignmentId/files', uploadAssignmentFiles, handleMulterError, async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { assignmentId } = req.params;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify assignment belongs to professor's course
    const assignmentCheck = await pool.query(
      'SELECT id FROM assignments WHERE id = $1 AND course_id = $2',
      [assignmentId, courseId]
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    await client.query('BEGIN');

    const uploadedFiles = [];

    for (const file of files) {
      // Generate unique file path
      const timestamp = Date.now();
      const filePath = `assignments/${assignmentId}/${timestamp}-${file.originalname}`;

      // Upload to GCS
      const uploadResult = await uploadFile(file, filePath);

      // Save to database
      const result = await client.query(
        `INSERT INTO assignment_files (assignment_id, file_name, file_path, file_size, file_type, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [assignmentId, uploadResult.fileName, uploadResult.filePath, uploadResult.fileSize, file.mimetype, req.user!.userId]
      );

      uploadedFiles.push(result.rows[0]);
    }

    await client.query('COMMIT');

    // Log each file upload
    for (const file of uploadedFiles) {
      logUsage({
        userId: req.user!.userId,
        actionType: 'file_upload',
        endpoint: `/api/professor/assignments/${assignmentId}/files`,
        method: 'POST',
        statusCode: 201,
        metadata: {
          courseId,
          assignmentId,
          fileId: file.id,
          fileName: file.file_name,
          fileSize: file.file_size,
          fileType: file.file_type,
        },
      });
    }

    res.status(201).json({
      message: 'Assignment files uploaded successfully',
      files: uploadedFiles
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error uploading assignment files:', error);
    res.status(500).json({ error: 'Failed to upload assignment files' });
  } finally {
    client.release();
  }
});

// Read one authorized assignment without scanning the paginated list.
router.get('/assignments/:assignmentId', async (req, res) => {
  const assignmentId = Number(req.params.assignmentId);
  if (!Number.isSafeInteger(assignmentId) || assignmentId < 1)
    return res.status(400).json({ error: 'Invalid assignment ID' });
  try {
    const result = await pool.query(`SELECT a.* FROM assignments a
      JOIN course_instructors ci ON ci.course_id=a.course_id
      WHERE a.id=$1 AND ci.user_id=$2`, [assignmentId, req.user!.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ assignment: result.rows[0] });
  } catch {
    res.status(500).json({ error: 'Failed to fetch assignment' });
  }
});

// Get all files for an assignment
router.get('/assignments/:assignmentId/files', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    let limit: number, cursor;
    const scope = `professor-assignment-files:${req.user!.userId}:${assignmentId}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify assignment belongs to professor's course
    const assignmentCheck = await pool.query(
      'SELECT id FROM assignments WHERE id = $1 AND course_id = $2',
      [assignmentId, courseId]
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Get files
    const result = await pool.query(
      `SELECT af.*, af.uploaded_at::text AS cursor_time, u.full_name as uploader_name
       FROM assignment_files af
       JOIN users u ON af.uploaded_by = u.id
       WHERE af.assignment_id = $1
       ${cursor ? 'AND (af.uploaded_at,af.id) < ($2::timestamp,$3::bigint)' : ''}
       ORDER BY af.uploaded_at DESC,af.id DESC LIMIT $${cursor ? 4 : 2}`,
      cursor ? [assignmentId, cursor.at, cursor.id, limit + 1] : [assignmentId, limit + 1]
    );

    const hasMore = result.rows.length > limit;
    const files = result.rows.slice(0, limit);
    res.json({
      message: 'Assignment files retrieved successfully',
      items: files, files,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(files[files.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching assignment files:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete assignment file
router.delete('/assignments/:assignmentId/files/:fileId', async (req, res) => {
  const client = await pool.connect();

  try {
    const { assignmentId, fileId } = req.params;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify assignment belongs to professor's course
    const assignmentCheck = await pool.query(
      'SELECT id FROM assignments WHERE id = $1 AND course_id = $2',
      [assignmentId, courseId]
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    await client.query('BEGIN');

    // Get file details
    const fileResult = await client.query(
      'SELECT * FROM assignment_files WHERE id = $1 AND assignment_id = $2',
      [fileId, assignmentId]
    );

    if (fileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];

    // Delete from GCS
    await deleteFile(file.file_path);

    // Delete from database
    await client.query('DELETE FROM assignment_files WHERE id = $1', [fileId]);

    await client.query('COMMIT');

    res.json({
      message: 'Assignment file deleted successfully',
      file: file
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting assignment file:', error);
    res.status(500).json({ error: 'Failed to delete assignment file' });
  } finally {
    client.release();
  }
});

// Get all submissions for an assignment
router.get('/assignments/:assignmentId/submissions', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const sort = req.query.sort === undefined ? 'submitted_desc' : req.query.sort;
    const gradeState = req.query.gradeState === undefined ? 'all' : req.query.gradeState;
    const student = req.query.student === undefined ? '' : req.query.student;
    if (typeof sort !== 'string' || !['submitted_desc','submitted_asc','student_asc','student_desc'].includes(sort) ||
        typeof gradeState !== 'string' || !['all','graded','ungraded'].includes(gradeState) ||
        typeof student !== 'string' || student.length > 100)
      return res.status(400).json({ error: 'Invalid submission filters' });
    const studentSearch = student.trim();
    let limit: number, cursor;
    const scope = `professor-submissions:${req.user!.userId}:${assignmentId}:${sort}:${gradeState}:${studentSearch}`;
    try { limit = parseLimit(req.query.limit); cursor = decodeCursor(req.query.cursor, scope); }
    catch { return res.status(400).json({ error: 'Invalid pagination' }); }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify assignment belongs to professor's course
    const assignmentCheck = await pool.query(
      'SELECT id FROM assignments WHERE id = $1 AND course_id = $2',
      [assignmentId, courseId]
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Get submissions with student details and files
    const byStudent = sort.startsWith('student_');
    const ascending = sort.endsWith('_asc');
    const sortColumn = byStudent ? 'u.full_name' : 'asub.submitted_at';
    const sortDirection = ascending ? 'ASC' : 'DESC';
    const cursorOperator = ascending ? '>' : '<';
    const params: any[] = [assignmentId];
    let conditions = '';
    if (gradeState === 'graded') conditions += ' AND asub.grade IS NOT NULL';
    if (gradeState === 'ungraded') conditions += ' AND asub.grade IS NULL';
    if (studentSearch) {
      params.push(`%${studentSearch}%`);
      conditions += ` AND u.full_name ILIKE $${params.length}`;
    }
    if (cursor) {
      params.push(cursor.at, cursor.id);
      conditions += ` AND (${sortColumn},asub.id) ${cursorOperator} ($${params.length - 1}::${byStudent ? 'text' : 'timestamp'},$${params.length}::bigint)`;
    }
    params.push(limit + 1);
    const result = await pool.query(
      `SELECT
        asub.id, asub.submission_text, asub.grade, asub.feedback,
        asub.submitted_at, asub.graded_at, ${sortColumn}::text AS cursor_time,
        u.id as student_id, u.full_name as student_name, u.email as student_email,
        (SELECT row_to_json(tg) FROM tentative_grades tg
         WHERE tg.submission_id = asub.id ORDER BY tg.id DESC LIMIT 1) AS tentative_grade,
        json_agg(
          json_build_object(
            'id', sf.id,
            'file_name', sf.file_name,
            'file_path', sf.file_path,
            'file_size', sf.file_size,
            'file_type', sf.file_type,
            'uploaded_at', sf.uploaded_at
          )
        ) FILTER (WHERE sf.id IS NOT NULL) as files
       FROM assignment_submissions asub
       JOIN users u ON asub.student_id = u.id
       LEFT JOIN submission_files sf ON asub.id = sf.submission_id
       WHERE asub.assignment_id = $1 ${conditions}
       GROUP BY asub.id, u.id
       ORDER BY ${sortColumn} ${sortDirection},asub.id ${sortDirection} LIMIT $${params.length}`,
      params
    );

    const hasMore = result.rows.length > limit;
    const submissions = result.rows.slice(0, limit);
    res.json({
      message: 'Assignment submissions retrieved successfully',
      items: submissions, submissions,
      page: { hasMore, nextCursor: hasMore ? encodeCursor(cursorFromRow(submissions[submissions.length - 1], 'cursor_time'), scope) : null }
    });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Grade a submission
router.put('/submissions/:submissionId/grade', async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { grade, feedback } = req.body;

    if (grade === undefined || grade === null) {
      return res.status(400).json({ error: 'Grade is required' });
    }

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Verify submission belongs to professor's course
    const submissionCheck = await pool.query(
      `SELECT asub.id FROM assignment_submissions asub
       JOIN assignments a ON asub.assignment_id = a.id
       WHERE asub.id = $1 AND a.course_id = $2`,
      [submissionId, courseId]
    );

    if (submissionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Update grade
    const result = await pool.query(
      `UPDATE assignment_submissions
       SET grade = $1, feedback = $2, graded_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [grade, feedback || null, submissionId]
    );

    res.json({
      message: 'Submission graded successfully',
      submission: result.rows[0]
    });
  } catch (error) {
    console.error('Error grading submission:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signed URL for submission file download
router.get('/submissions/files/:fileId/download', async (req, res) => {
  try {
    const { fileId } = req.params;

    // Get professor's course
    const courseResult = await pool.query(
      'SELECT course_id FROM course_instructors WHERE user_id = $1',
      [req.user!.userId]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({ error: 'No course assigned' });
    }

    const courseId = courseResult.rows[0].course_id;

    // Get file with course verification
    const result = await pool.query(
      `SELECT sf.* FROM submission_files sf
       JOIN assignment_submissions asub ON sf.submission_id = asub.id
       JOIN assignments a ON asub.assignment_id = a.id
       WHERE sf.id = $1 AND a.course_id = $2`,
      [fileId, courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result.rows[0];

    // Generate signed URL (valid for 60 minutes)
    const signedUrl = await generateSignedUrl(file.file_path, 60);

    res.json({
      message: 'Download URL generated successfully',
      url: signedUrl,
      fileName: file.file_name
    });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

export default router;
