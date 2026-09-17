import express from 'express';
import { pool } from '../config/database';
import { authenticate, authorize } from '../middleware/auth';
import { generateSignedUrl } from '../config/storage';
import { getSourceOfTruthMode, setSourceOfTruthMode } from '../services/settingsService';
import { purgeCourseIndex } from '../services/materials/deleteCourseIndex';

const router = express.Router();

// Apply authentication and authorization to all root routes
router.use(authenticate);
router.use(authorize('root'));

// Get all pending professor approvals
router.get('/professors/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.status, u.created_at,
              ci.course_id, c.title as course_title
       FROM users u
       LEFT JOIN course_instructors ci ON u.id = ci.user_id
       LEFT JOIN courses c ON ci.course_id = c.id
       WHERE u.role = 'professor' AND u.status = 'pending'
       ORDER BY u.created_at DESC`
    );

    res.json({
      message: 'Pending professor approvals retrieved successfully',
      professors: result.rows
    });
  } catch (error) {
    console.error('Error fetching pending professors:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve or reject professor
router.patch('/professors/:id/status', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    if (!['approved', 'rejected', 'active'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        message: 'Status must be one of: approved, rejected, active'
      });
    }

    await client.query('BEGIN');

    // Check if user exists and is a professor
    const user = await client.query(
      'SELECT id, role, full_name, email FROM users WHERE id = $1',
      [id]
    );

    if (user.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.rows[0].role !== 'professor') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User is not a professor' });
    }

    // Update user status
    const result = await client.query(
      'UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, full_name, email, role, status',
      [status, id]
    );

    await client.query('COMMIT');

    res.json({
      message: `Professor ${status} successfully`,
      user: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating professor status:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const { role, status } = req.query;

    let query = 'SELECT id, full_name, email, role, status, created_at, updated_at FROM users WHERE 1=1';
    const params: any[] = [];
    let paramCount = 1;

    if (role) {
      query += ` AND role = $${paramCount}`;
      params.push(role);
      paramCount++;
    }

    if (status) {
      query += ` AND status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    res.json({
      message: 'Users retrieved successfully',
      users: result.rows
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all courses
router.get('/courses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.created_at, c.updated_at,
              c.instructor_id,
              u.full_name as instructor_name,
              u.email as instructor_email,
              COUNT(DISTINCT e.id) as enrolled_students
       FROM courses c
       LEFT JOIN users u ON c.instructor_id = u.id
       LEFT JOIN enrollments e ON c.id = e.course_id
       GROUP BY c.id, u.id
       ORDER BY c.created_at DESC`
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

// Create a new course
router.post('/courses', async (req, res) => {
  try {
    const { title, description, instructorId } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Course title is required' });
    }

    // If instructor is provided, verify they exist and are a professor
    if (instructorId) {
      const instructor = await pool.query(
        'SELECT id, role FROM users WHERE id = $1',
        [instructorId]
      );

      if (instructor.rows.length === 0) {
        return res.status(404).json({ error: 'Instructor not found' });
      }

      if (instructor.rows[0].role !== 'professor') {
        return res.status(400).json({ error: 'Instructor must be a professor' });
      }
    }

    const result = await pool.query(
      'INSERT INTO courses (title, description, instructor_id) VALUES ($1, $2, $3) RETURNING *',
      [title, description || null, instructorId || null]
    );

    res.status(201).json({
      message: 'Course created successfully',
      course: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a course
router.put('/courses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, instructorId } = req.body;

    // Check if course exists
    const course = await pool.query('SELECT id FROM courses WHERE id = $1', [id]);

    if (course.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // If instructor is provided, verify they exist and are a professor
    if (instructorId) {
      const instructor = await pool.query(
        'SELECT id, role FROM users WHERE id = $1',
        [instructorId]
      );

      if (instructor.rows.length === 0) {
        return res.status(404).json({ error: 'Instructor not found' });
      }

      if (instructor.rows[0].role !== 'professor') {
        return res.status(400).json({ error: 'Instructor must be a professor' });
      }
    }

    const result = await pool.query(
      `UPDATE courses
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           instructor_id = COALESCE($3, instructor_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [title, description, instructorId, id]
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

// Delete a course
router.delete('/courses/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // Check if course exists
    const course = await client.query(
      'SELECT id, title FROM courses WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (course.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Course not found' });
    }

    // New immutable evidence references must be cleared before a permanent course purge.
    await purgeCourseIndex(client, Number(id));

    // Delete related data first
    // Delete announcements for this course
    await client.query(
      'DELETE FROM announcements WHERE course_id = $1',
      [id]
    );

    // Delete assignments for this course
    await client.query(
      'DELETE FROM assignments WHERE course_id = $1',
      [id]
    );

    // Delete enrollments for this course
    await client.query(
      'DELETE FROM enrollments WHERE course_id = $1',
      [id]
    );

    // Delete course instructor assignments (has CASCADE, but being explicit)
    await client.query(
      'DELETE FROM course_instructors WHERE course_id = $1',
      [id]
    );

    // Finally, delete the course
    const result = await client.query(
      'DELETE FROM courses WHERE id = $1 RETURNING id, title',
      [id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Course deleted successfully',
      course: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting course:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Delete a user
router.delete('/users/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    // Prevent deleting the root user making the request
    if (req.user && req.user.userId === parseInt(id)) {
      return res.status(400).json({
        error: 'Cannot delete yourself',
        message: 'You cannot delete your own account'
      });
    }

    await client.query('BEGIN');

    // Check if user exists
    const user = await client.query(
      'SELECT id, full_name, email, role FROM users WHERE id = $1',
      [id]
    );

    if (user.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    // If user is a professor, handle course assignments
    if (user.rows[0].role === 'professor') {
      // Set instructor_id to NULL for courses taught by this professor
      await client.query(
        'UPDATE courses SET instructor_id = NULL WHERE instructor_id = $1',
        [id]
      );

      // Delete from course_instructors (has ON DELETE CASCADE, but doing explicitly)
      await client.query(
        'DELETE FROM course_instructors WHERE user_id = $1',
        [id]
      );

      // Delete announcements created by this professor
      await client.query(
        'DELETE FROM announcements WHERE author_id = $1',
        [id]
      );
    }

    // If user is a student, delete their enrollments
    if (user.rows[0].role === 'student') {
      await client.query(
        'DELETE FROM enrollments WHERE user_id = $1',
        [id]
      );
    }

    // Delete the user
    const result = await client.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, full_name, email, role',
      [id]
    );

    await client.query('COMMIT');

    res.json({
      message: 'User deleted successfully',
      user: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get all enrollments
router.get('/enrollments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.enrolled_at,
              e.user_id, u.full_name as student_name, u.email as student_email,
              e.course_id, c.title as course_title
       FROM enrollments e
       JOIN users u ON e.user_id = u.id
       JOIN courses c ON e.course_id = c.id
       ORDER BY e.enrolled_at DESC`
    );

    res.json({
      message: 'Enrollments retrieved successfully',
      enrollments: result.rows
    });
  } catch (error) {
    console.error('Error fetching enrollments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get system statistics
router.get('/stats', async (req, res) => {
  try {
    const [users, courses, enrollments, pendingProfessors] = await Promise.all([
      pool.query('SELECT role, COUNT(*) as count FROM users GROUP BY role'),
      pool.query('SELECT COUNT(*) as count FROM courses'),
      pool.query('SELECT COUNT(*) as count FROM enrollments'),
      pool.query('SELECT COUNT(*) as count FROM users WHERE role = $1 AND status = $2', ['professor', 'pending'])
    ]);

    const usersByRole = users.rows.reduce((acc, row) => {
      acc[row.role] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    res.json({
      message: 'System statistics retrieved successfully',
      stats: {
        users: usersByRole,
        totalCourses: parseInt(courses.rows[0].count),
        totalEnrollments: parseInt(enrollments.rows[0].count),
        pendingProfessors: parseInt(pendingProfessors.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Error fetching system stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all professors with their assigned courses
router.get('/professors', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.status, u.created_at,
              json_agg(
                json_build_object(
                  'course_id', c.id,
                  'course_title', c.title,
                  'assigned_at', ci.assigned_at
                )
              ) FILTER (WHERE c.id IS NOT NULL) as assigned_courses
       FROM users u
       LEFT JOIN course_instructors ci ON u.id = ci.user_id
       LEFT JOIN courses c ON ci.course_id = c.id
       WHERE u.role = 'professor'
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );

    res.json({
      message: 'Professors retrieved successfully',
      professors: result.rows
    });
  } catch (error) {
    console.error('Error fetching professors:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign course to professor
router.post('/professors/:professorId/courses', async (req, res) => {
  const client = await pool.connect();

  try {
    const { professorId } = req.params;
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required' });
    }

    await client.query('BEGIN');

    // Verify professor exists and is approved
    const professor = await client.query(
      'SELECT id, role, status FROM users WHERE id = $1',
      [professorId]
    );

    if (professor.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Professor not found' });
    }

    if (professor.rows[0].role !== 'professor') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User is not a professor' });
    }

    // Verify course exists
    const course = await client.query(
      'SELECT id, title FROM courses WHERE id = $1',
      [courseId]
    );

    if (course.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if course already has an instructor
    const existingInstructor = await client.query(
      'SELECT user_id FROM course_instructors WHERE course_id = $1',
      [courseId]
    );

    if (existingInstructor.rows.length > 0) {
      // If the same professor, just return success
      if (existingInstructor.rows[0].user_id === parseInt(professorId)) {
        await client.query('ROLLBACK');
        return res.status(200).json({
          message: 'Professor already assigned to this course'
        });
      }

      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This course already has an instructor assigned',
        message: 'Please remove the current instructor first or choose a different course'
      });
    }

    // Create course instructor assignment
    await client.query(
      'INSERT INTO course_instructors (user_id, course_id) VALUES ($1, $2)',
      [professorId, courseId]
    );

    // Update course's instructor_id
    await client.query(
      'UPDATE courses SET instructor_id = $1 WHERE id = $2',
      [professorId, courseId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Course assigned to professor successfully',
      assignment: {
        professorId: parseInt(professorId),
        courseId,
        courseTitle: course.rows[0].title
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error assigning course to professor:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Remove course from professor
router.delete('/professors/:professorId/courses/:courseId', async (req, res) => {
  const client = await pool.connect();

  try {
    const { professorId, courseId } = req.params;

    await client.query('BEGIN');

    // Verify the assignment exists
    const assignment = await client.query(
      'SELECT id FROM course_instructors WHERE user_id = $1 AND course_id = $2',
      [professorId, courseId]
    );

    if (assignment.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Course assignment not found' });
    }

    // Remove from course_instructors
    await client.query(
      'DELETE FROM course_instructors WHERE user_id = $1 AND course_id = $2',
      [professorId, courseId]
    );

    // Update course's instructor_id to null
    await client.query(
      'UPDATE courses SET instructor_id = NULL WHERE id = $1',
      [courseId]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Course removed from professor successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error removing course from professor:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---- Global settings: source-of-truth mode ----
router.get('/settings/source-of-truth', async (_req, res) => {
  res.json({ mode: await getSourceOfTruthMode() });
});

router.put('/settings/source-of-truth', async (req, res) => {
  const { mode } = req.body;
  if (mode !== 'strict' && mode !== 'external') {
    return res.status(400).json({ error: "mode must be 'strict' or 'external'" });
  }
  await setSourceOfTruthMode(mode, req.user!.userId);
  res.json({ mode });
});

// ========== FILE MANAGEMENT ENDPOINTS ==========

// Get all course materials across all courses
router.get('/files/materials', async (req, res) => {
  try {
    const { courseId, professorId } = req.query;

    let query = `
      SELECT cm.*,
             c.title as course_title, c.id as course_id,
             u.full_name as uploader_name, u.email as uploader_email
      FROM course_materials cm
      JOIN courses c ON cm.course_id = c.id
      JOIN users u ON cm.uploaded_by = u.id
      WHERE cm.deleted_at IS NULL
    `;
    const params: any[] = [];
    let paramCount = 1;

    if (courseId) {
      query += ` AND cm.course_id = $${paramCount}`;
      params.push(courseId);
      paramCount++;
    }

    if (professorId) {
      query += ` AND cm.uploaded_by = $${paramCount}`;
      params.push(professorId);
      paramCount++;
    }

    query += ' ORDER BY cm.uploaded_at DESC';

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

// Get all assignment submissions across all courses
router.get('/files/submissions', async (req, res) => {
  try {
    const { courseId, studentId, assignmentId } = req.query;

    let query = `
      SELECT asub.*,
             a.title as assignment_title, a.id as assignment_id,
             c.title as course_title, c.id as course_id,
             u.full_name as student_name, u.email as student_email,
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
      JOIN assignments a ON asub.assignment_id = a.id
      JOIN courses c ON a.course_id = c.id
      JOIN users u ON asub.student_id = u.id
      LEFT JOIN submission_files sf ON asub.id = sf.submission_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramCount = 1;

    if (courseId) {
      query += ` AND c.id = $${paramCount}`;
      params.push(courseId);
      paramCount++;
    }

    if (studentId) {
      query += ` AND asub.student_id = $${paramCount}`;
      params.push(studentId);
      paramCount++;
    }

    if (assignmentId) {
      query += ` AND asub.assignment_id = $${paramCount}`;
      params.push(assignmentId);
      paramCount++;
    }

    query += ' GROUP BY asub.id, a.id, c.id, u.id ORDER BY asub.submitted_at DESC';

    const result = await pool.query(query, params);

    res.json({
      message: 'Assignment submissions retrieved successfully',
      submissions: result.rows
    });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get file statistics
router.get('/files/stats', async (req, res) => {
  try {
    const [materials, submissions, assignmentFiles] = await Promise.all([
      pool.query('SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size FROM course_materials WHERE deleted_at IS NULL'),
      pool.query('SELECT COUNT(*) as count FROM assignment_submissions'),
      pool.query('SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size FROM submission_files')
    ]);

    const materialStats = materials.rows[0];
    const submissionStats = submissions.rows[0];
    const submissionFileStats = assignmentFiles.rows[0];

    res.json({
      message: 'File statistics retrieved successfully',
      stats: {
        courseMaterials: {
          count: parseInt(materialStats.count),
          totalSize: parseInt(materialStats.total_size)
        },
        submissions: {
          count: parseInt(submissionStats.count)
        },
        submissionFiles: {
          count: parseInt(submissionFileStats.count),
          totalSize: parseInt(submissionFileStats.total_size)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching file stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get signed URL for any file (admin access)
router.get('/files/download/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;

    let filePath: string | null = null;
    let fileName: string | null = null;

    if (type === 'material') {
      const result = await pool.query(
        'SELECT file_path, file_name FROM course_materials WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Material not found' });
      }

      filePath = result.rows[0].file_path;
      fileName = result.rows[0].file_name;
    } else if (type === 'submission') {
      const result = await pool.query(
        'SELECT file_path, file_name FROM submission_files WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Submission file not found' });
      }

      filePath = result.rows[0].file_path;
      fileName = result.rows[0].file_name;
    } else if (type === 'assignment') {
      const result = await pool.query(
        'SELECT file_path, file_name FROM assignment_files WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Assignment file not found' });
      }

      filePath = result.rows[0].file_path;
      fileName = result.rows[0].file_name;
    } else {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    if (!filePath) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Generate signed URL (valid for 60 minutes)
    const signedUrl = await generateSignedUrl(filePath, 60);

    res.json({
      message: 'Download URL generated successfully',
      url: signedUrl,
      fileName: fileName
    });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

export default router;
