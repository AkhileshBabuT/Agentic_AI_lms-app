import express, { Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate, authorize, requireActiveStatus } from '../middleware/auth';
import { uploadSubmissionFiles, validateSubmissionSize, handleMulterError } from '../middleware/upload';
import { uploadFile, generateSignedUrl } from '../config/storage';
import { logUsage } from '../utils/usageLogger';

const router = express.Router();

// Apply authentication and authorization to all student routes
router.use(authenticate);
router.use(authorize('student'));
router.use(requireActiveStatus);

// Get all available courses
router.get('/courses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.created_at,
              u.full_name as instructor_name,
              u.email as instructor_email,
              COUNT(DISTINCT e.id) as enrolled_students_count,
              EXISTS(
                SELECT 1 FROM enrollments
                WHERE course_id = c.id AND user_id = $1
              ) as is_enrolled
       FROM courses c
       LEFT JOIN users u ON c.instructor_id = u.id
       LEFT JOIN enrollments e ON c.id = e.course_id
       GROUP BY c.id, u.id
       ORDER BY c.title ASC`,
      [req.user!.userId]
    );

    res.json({
      message: 'Courses retrieved successfully',
      courses: result.rows
    });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get student's enrolled courses
router.get('/my-courses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.created_at,
              u.full_name as instructor_name,
              u.email as instructor_email,
              e.enrolled_at
       FROM enrollments e
       JOIN courses c ON e.course_id = c.id
       LEFT JOIN users u ON c.instructor_id = u.id
       WHERE e.user_id = $1
       ORDER BY e.enrolled_at DESC`,
      [req.user!.userId]
    );

    res.json({
      message: 'Enrolled courses retrieved successfully',
      courses: result.rows
    });
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enroll in a course
router.post('/courses/:courseId/enroll', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Check if course exists
    const course = await pool.query(
      'SELECT id, title FROM courses WHERE id = $1',
      [courseId]
    );

    if (course.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if already enrolled
    const existingEnrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (existingEnrollment.rows.length > 0) {
      return res.status(400).json({
        error: 'Already enrolled',
        message: 'You are already enrolled in this course'
      });
    }

    // Enroll student
    const result = await pool.query(
      'INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2) RETURNING *',
      [req.user!.userId, courseId]
    );

    res.status(201).json({
      message: `Successfully enrolled in ${course.rows[0].title}`,
      enrollment: result.rows[0]
    });
  } catch (error) {
    console.error('Error enrolling in course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unenroll from a course
router.delete('/courses/:courseId/enroll', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Check if enrolled
    const result = await pool.query(
      `DELETE FROM enrollments
       WHERE user_id = $1 AND course_id = $2
       RETURNING id, course_id`,
      [req.user!.userId, courseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not enrolled',
        message: 'You are not enrolled in this course'
      });
    }

    res.json({
      message: 'Successfully unenrolled from course',
      enrollment: result.rows[0]
    });
  } catch (error) {
    console.error('Error unenrolling from course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get course details with assignments and announcements
router.get('/courses/:courseId', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Verify student is enrolled in the course
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course to view its details'
      });
    }

    // Get course details
    const course = await pool.query(
      `SELECT c.id, c.title, c.description, c.created_at, c.updated_at,
              u.full_name as instructor_name,
              u.email as instructor_email
       FROM courses c
       LEFT JOIN users u ON c.instructor_id = u.id
       WHERE c.id = $1`,
      [courseId]
    );

    if (course.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Get assignments
    const assignments = await pool.query(
      `SELECT id, title, description, question_text, due_date, points, created_at
       FROM assignments
       WHERE course_id = $1
       ORDER BY due_date DESC`,
      [courseId]
    );

    // Get announcements
    const announcements = await pool.query(
      `SELECT a.id, a.title, a.content, a.created_at,
              u.full_name as author_name
       FROM announcements a
       JOIN users u ON a.author_id = u.id
       WHERE a.course_id = $1
       ORDER BY a.created_at DESC`,
      [courseId]
    );

    res.json({
      message: 'Course details retrieved successfully',
      course: {
        ...course.rows[0],
        assignments: assignments.rows,
        announcements: announcements.rows
      }
    });
  } catch (error) {
    console.error('Error fetching course details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all assignments for a course
router.get('/courses/:courseId/assignments', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Verify student is enrolled in the course
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course to view its assignments'
      });
    }

    // Get assignments
    const assignments = await pool.query(
      `SELECT id, title, description, question_text, due_date, points, created_at
       FROM assignments
       WHERE course_id = $1
       ORDER BY due_date DESC`,
      [courseId]
    );

    res.json({
      message: 'Assignments retrieved successfully',
      courseId: courseId,
      assignments: assignments.rows
    });
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all announcements for a course
router.get('/courses/:courseId/announcements', async (req, res) => {
  try {
    const { courseId } = req.params;

    // Verify student is enrolled in the course
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course to view its announcements'
      });
    }

    // Get announcements
    const announcements = await pool.query(
      `SELECT a.id, a.title, a.content, a.created_at,
              u.full_name as author_name
       FROM announcements a
       JOIN users u ON a.author_id = u.id
       WHERE a.course_id = $1
       ORDER BY a.created_at DESC`,
      [courseId]
    );

    res.json({
      message: 'Announcements retrieved successfully',
      courseId: courseId,
      announcements: announcements.rows
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== COURSE MATERIALS ENDPOINTS ==========

// Get folders for a course (student view, read-only)
router.get('/courses/:courseId/folders', async (req, res) => {
  try {
    const { courseId } = req.params;
    const folderId = req.query.folderId ? parseInt(req.query.folderId as string) : null;

    // Verify student is enrolled
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let query: string;
    let params: any[];

    if (folderId === null) {
      query = `
        SELECT mf.id, mf.name, mf.parent_id, mf.created_at
        FROM material_folders mf
        WHERE mf.course_id = $1 AND mf.parent_id IS NULL
        ORDER BY mf.name ASC
      `;
      params = [courseId];
    } else {
      query = `
        SELECT mf.id, mf.name, mf.parent_id, mf.created_at
        FROM material_folders mf
        WHERE mf.course_id = $1 AND mf.parent_id = $2
        ORDER BY mf.name ASC
      `;
      params = [courseId, folderId];
    }

    const result = await pool.query(query, params);

    res.json({ folders: result.rows });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get folder breadcrumb (student view)
router.get('/courses/:courseId/folders/:id/breadcrumb', async (req, res) => {
  try {
    const { courseId, id } = req.params;

    // Verify student is enrolled
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

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

    res.json({ breadcrumb: result.rows });
  } catch (error) {
    console.error('Error fetching breadcrumb:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get course materials for an enrolled course (optionally filtered by folder)
router.get('/courses/:courseId/materials', async (req, res) => {
  try {
    const { courseId } = req.params;
    const folderIdParam = req.query.folderId as string | undefined;
    const hasFolderFilter = folderIdParam !== undefined;
    const folderId = hasFolderFilter
      ? (folderIdParam === 'null' || folderIdParam === '' ? null : parseInt(folderIdParam))
      : undefined;

    // Verify student is enrolled in the course
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, courseId]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course to view its materials'
      });
    }

    let query: string;
    let params: any[];

    if (!hasFolderFilter) {
      // No filter = all materials (backward compatible)
      query = `
        SELECT cm.*, u.full_name as uploader_name
        FROM course_materials cm
        JOIN users u ON cm.uploaded_by = u.id
        WHERE cm.course_id = $1 AND cm.deleted_at IS NULL AND cm.visibility = 'published'
        ORDER BY cm.uploaded_at DESC
      `;
      params = [courseId];
    } else if (folderId === null) {
      // Root folder
      query = `
        SELECT cm.*, u.full_name as uploader_name
        FROM course_materials cm
        JOIN users u ON cm.uploaded_by = u.id
        WHERE cm.course_id = $1 AND cm.deleted_at IS NULL AND cm.visibility = 'published' AND cm.folder_id IS NULL
        ORDER BY cm.uploaded_at DESC
      `;
      params = [courseId];
    } else {
      // Specific folder
      query = `
        SELECT cm.*, u.full_name as uploader_name
        FROM course_materials cm
        JOIN users u ON cm.uploaded_by = u.id
        WHERE cm.course_id = $1 AND cm.deleted_at IS NULL AND cm.visibility = 'published' AND cm.folder_id = $2
        ORDER BY cm.uploaded_at DESC
      `;
      params = [courseId, folderId];
    }

    const result = await pool.query(query, params);

    res.json({
      message: 'Course materials retrieved successfully',
      materials: result.rows
    });
  } catch (error) {
    console.error('Error fetching course materials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signed URL for course material download
router.get('/materials/:id/download', async (req, res) => {
  try {
    const { id } = req.params;

    // Get material and verify student is enrolled
    const result = await pool.query(
      `SELECT cm.* FROM course_materials cm
       JOIN enrollments e ON cm.course_id = e.course_id
       WHERE cm.id = $1 AND e.user_id = $2 AND cm.deleted_at IS NULL AND cm.visibility = 'published'`,
      [id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Material not found or you are not enrolled in this course'
      });
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

// ========== ASSIGNMENT SUBMISSION ENDPOINTS ==========

// Get assignment details with files
router.get('/assignments/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;

    // Get assignment details
    const assignmentResult = await pool.query(
      `SELECT a.*, c.id as course_id, c.title as course_title
       FROM assignments a
       JOIN courses c ON a.course_id = c.id
       WHERE a.id = $1`,
      [assignmentId]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentResult.rows[0];

    // Verify student is enrolled in the course
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, assignment.course_id]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course to view this assignment'
      });
    }

    // Get assignment files
    const filesResult = await pool.query(
      `SELECT af.*, u.full_name as uploader_name
       FROM assignment_files af
       JOIN users u ON af.uploaded_by = u.id
       WHERE af.assignment_id = $1
       ORDER BY af.uploaded_at DESC`,
      [assignmentId]
    );

    // Get student's submission if exists
    const submissionResult = await pool.query(
      `SELECT asub.*, json_agg(
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
       LEFT JOIN submission_files sf ON asub.id = sf.submission_id
       WHERE asub.assignment_id = $1 AND asub.student_id = $2
       GROUP BY asub.id`,
      [assignmentId, req.user!.userId]
    );

    res.json({
      message: 'Assignment details retrieved successfully',
      assignment: {
        ...assignment,
        assignmentFiles: filesResult.rows,
        submission: submissionResult.rows.length > 0 ? submissionResult.rows[0] : null
      }
    });
  } catch (error) {
    console.error('Error fetching assignment details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit assignment
router.post('/assignments/:assignmentId/submit', uploadSubmissionFiles, validateSubmissionSize, handleMulterError, async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const { assignmentId } = req.params;
    const { submissionText } = req.body;
    const files = req.files as Express.Multer.File[];

    // Get assignment and verify enrollment
    const assignmentResult = await pool.query(
      `SELECT a.*, c.id as course_id
       FROM assignments a
       JOIN courses c ON a.course_id = c.id
       WHERE a.id = $1`,
      [assignmentId]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentResult.rows[0];

    // Verify student is enrolled
    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, assignment.course_id]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course to submit this assignment'
      });
    }

    await client.query('BEGIN');

    // Check if submission already exists
    const existingSubmission = await client.query(
      'SELECT id FROM assignment_submissions WHERE assignment_id = $1 AND student_id = $2',
      [assignmentId, req.user!.userId]
    );

    let submissionId;

    if (existingSubmission.rows.length > 0) {
      // Update existing submission
      submissionId = existingSubmission.rows[0].id;

      await client.query(
        `UPDATE assignment_submissions
         SET submission_text = $1, submitted_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [submissionText || null, submissionId]
      );

      // Delete old files from database (GCS files will be overwritten with new timestamps)
      await client.query('DELETE FROM submission_files WHERE submission_id = $1', [submissionId]);
    } else {
      // Create new submission
      const submissionResult = await client.query(
        `INSERT INTO assignment_submissions (assignment_id, student_id, submission_text)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [assignmentId, req.user!.userId, submissionText || null]
      );

      submissionId = submissionResult.rows[0].id;
    }

    // Upload files to GCS
    const uploadedFiles = [];

    if (files && files.length > 0) {
      for (const file of files) {
        const timestamp = Date.now();
        const filePath = `submissions/${assignmentId}/${req.user!.userId}/${timestamp}-${file.originalname}`;

        // Upload to GCS
        const uploadResult = await uploadFile(file, filePath);

        // Save to database
        const fileResult = await client.query(
          `INSERT INTO submission_files (submission_id, file_name, file_path, file_size, file_type)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [submissionId, uploadResult.fileName, uploadResult.filePath, uploadResult.fileSize, file.mimetype]
        );

        uploadedFiles.push(fileResult.rows[0]);
      }
    }

    await client.query('COMMIT');

    // Log file uploads for this submission
    for (const file of uploadedFiles) {
      logUsage({
        userId: req.user!.userId,
        actionType: 'file_upload',
        endpoint: `/api/student/assignments/${assignmentId}/submit`,
        method: 'POST',
        statusCode: 201,
        metadata: {
          assignmentId,
          submissionId,
          fileId: file.id,
          fileName: file.file_name,
          fileSize: file.file_size,
          fileType: file.file_type,
        },
      });
    }

    // Trigger auto-grading in background (don't wait for it)
    // Student will see tentative grade asynchronously
    (async () => {
      try {
        const { GradingAssistantAgent } = await import('../services/agents/GradingAssistantAgent');
        const gradingAgent = new GradingAssistantAgent();

        // Check if there's an explicit rubric for this assignment
        const rubricResult = await pool.query(
          'SELECT * FROM grading_rubrics WHERE assignment_id = $1',
          [assignmentId]
        );

        const rubric = rubricResult.rows.length > 0 ? rubricResult.rows[0] : null;

        // Get file names for context
        const fileNames = uploadedFiles.map(f => f.file_name);

        // Generate tentative grade
        await gradingAgent.generateTentativeGrade(
          submissionId,
          parseInt(assignmentId),
          req.user!.userId,
          submissionText || '',
          fileNames,
          rubric
        );

        console.log(`✓ Tentative grade generated for submission ${submissionId}`);
      } catch (error) {
        console.error('Error generating tentative grade:', error);
        // Don't fail the submission if grading fails
      }
    })();

    res.status(201).json({
      message: 'Assignment submitted successfully',
      submission: {
        id: submissionId,
        assignment_id: assignmentId,
        student_id: req.user!.userId,
        submission_text: submissionText,
        files: uploadedFiles
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error submitting assignment:', error);
    res.status(500).json({ error: 'Failed to submit assignment' });
  } finally {
    client.release();
  }
});

// Get signed URL for assignment file download
router.get('/assignments/files/:fileId/download', async (req, res) => {
  try {
    const { fileId } = req.params;

    // Get file and verify student is enrolled in the course
    const result = await pool.query(
      `SELECT af.* FROM assignment_files af
       JOIN assignments a ON af.assignment_id = a.id
       JOIN enrollments e ON a.course_id = e.course_id
       WHERE af.id = $1 AND e.user_id = $2`,
      [fileId, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'File not found or you are not enrolled in this course'
      });
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

// Get my submission for an assignment
router.get('/assignments/:assignmentId/my-submission', async (req, res) => {
  try {
    const { assignmentId } = req.params;

    // Verify assignment exists and student is enrolled
    const assignmentResult = await pool.query(
      `SELECT a.*, c.id as course_id
       FROM assignments a
       JOIN courses c ON a.course_id = c.id
       WHERE a.id = $1`,
      [assignmentId]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentResult.rows[0];

    const enrollment = await pool.query(
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user!.userId, assignment.course_id]
    );

    if (enrollment.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You must be enrolled in this course'
      });
    }

    // Get submission
    const submissionResult = await pool.query(
      `SELECT asub.*, json_agg(
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
       LEFT JOIN submission_files sf ON asub.id = sf.submission_id
       WHERE asub.assignment_id = $1 AND asub.student_id = $2
       GROUP BY asub.id`,
      [assignmentId, req.user!.userId]
    );

    if (submissionResult.rows.length === 0) {
      return res.json({
        message: 'No submission found',
        submission: null
      });
    }

    res.json({
      message: 'Submission retrieved successfully',
      submission: submissionResult.rows[0]
    });
  } catch (error) {
    console.error('Error fetching submission:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
