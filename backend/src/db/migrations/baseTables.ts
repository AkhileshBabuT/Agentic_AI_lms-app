import { pool } from '../../config/database';

export const createTables = async () => {
  const client = await pool.connect();

  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'student',
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT users_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'active'))
      )
    `);

    // Add status column if it doesn't exist (for existing databases)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'status'
        ) THEN
          ALTER TABLE users ADD COLUMN status VARCHAR(50) DEFAULT 'active';
          ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'active'));
        END IF;
      END $$;
    `);

    // Courses table
    await client.query(`
      CREATE TABLE IF NOT EXISTS courses (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        instructor_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Enrollments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS enrollments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        course_id INTEGER REFERENCES courses(id),
        enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, course_id)
      )
    `);

    // Assignments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS assignments (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        question_text TEXT,
        course_id INTEGER REFERENCES courses(id),
        due_date TIMESTAMP,
        points INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add question_text column if it doesn't exist (for existing databases)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'assignments' AND column_name = 'question_text'
        ) THEN
          ALTER TABLE assignments ADD COLUMN question_text TEXT;
        END IF;
      END $$;
    `);

    // Announcements table
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        course_id INTEGER REFERENCES courses(id),
        author_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Course Instructors junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS course_instructors (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      )
    `);

    // Course Materials table
    await client.query(`
      CREATE TABLE IF NOT EXISTS course_materials (
        id SERIAL PRIMARY KEY,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        file_name VARCHAR(500) NOT NULL,
        file_path VARCHAR(1000) NOT NULL,
        file_size BIGINT,
        file_type VARCHAR(100),
        uploaded_by INTEGER NOT NULL REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Assignment Files table
    await client.query(`
      CREATE TABLE IF NOT EXISTS assignment_files (
        id SERIAL PRIMARY KEY,
        assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        file_name VARCHAR(500) NOT NULL,
        file_path VARCHAR(1000) NOT NULL,
        file_size BIGINT,
        file_type VARCHAR(100),
        uploaded_by INTEGER NOT NULL REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Assignment Submissions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS assignment_submissions (
        id SERIAL PRIMARY KEY,
        assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        submission_text TEXT,
        grade INTEGER,
        feedback TEXT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        graded_at TIMESTAMP,
        UNIQUE(assignment_id, student_id)
      )
    `);

    // Submission Files table
    await client.query(`
      CREATE TABLE IF NOT EXISTS submission_files (
        id SERIAL PRIMARY KEY,
        submission_id INTEGER NOT NULL REFERENCES assignment_submissions(id) ON DELETE CASCADE,
        file_name VARCHAR(500) NOT NULL,
        file_path VARCHAR(1000) NOT NULL,
        file_size BIGINT,
        file_type VARCHAR(100),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_course_instructors_user_id
      ON course_instructors(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_course_instructors_course_id
      ON course_instructors(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_user_id
      ON enrollments(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_course_id
      ON enrollments(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_assignments_course_id
      ON assignments(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_announcements_course_id
      ON announcements(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_announcements_author_id
      ON announcements(author_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_courses_instructor_id
      ON courses(instructor_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_course_materials_course_id
      ON course_materials(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_assignment_files_assignment_id
      ON assignment_files(assignment_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment_id
      ON assignment_submissions(assignment_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_assignment_submissions_student_id
      ON assignment_submissions(student_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_submission_files_submission_id
      ON submission_files(submission_id)
    `);

    // Chat Agents table - represents AI agents available for each course
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_agents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        agent_type VARCHAR(100) DEFAULT 'course_assistant',
        avatar_url VARCHAR(500),
        system_prompt TEXT,
        settings JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Chat Sessions table - tracks individual chat sessions between students and AI agents
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id INTEGER NOT NULL REFERENCES chat_agents(id) ON DELETE CASCADE,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        session_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        CONSTRAINT chat_sessions_status_check CHECK (status IN ('active', 'archived', 'deleted'))
      )
    `);

    // Chat Messages table - stores individual messages in chat sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        sender_type VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        message_metadata JSONB DEFAULT '{}',
        is_edited BOOLEAN DEFAULT false,
        is_deleted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chat_messages_sender_check CHECK (sender_type IN ('student', 'agent', 'system'))
      )
    `);

    // Agent Generated Content table - tracks content generated by AI agents (summaries, practice questions, etc.)
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_generated_content (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER NOT NULL REFERENCES chat_agents(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
        content_type VARCHAR(100) NOT NULL,
        title VARCHAR(500),
        content TEXT NOT NULL,
        content_metadata JSONB DEFAULT '{}',
        is_saved BOOLEAN DEFAULT false,
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT agent_content_type_check CHECK (content_type IN ('summary', 'practice_questions', 'explanation', 'study_guide', 'quiz', 'notes', 'other'))
      )
    `);

    // Create indexes for chat tables
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_student_id
      ON chat_sessions(student_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_course_id
      ON chat_sessions(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_id
      ON chat_sessions(agent_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
      ON chat_messages(session_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at
      ON chat_messages(created_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_generated_content_student_id
      ON agent_generated_content(student_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_generated_content_course_id
      ON agent_generated_content(course_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_generated_content_session_id
      ON agent_generated_content(session_id)
    `);

    // API Usage Logs table - tracks file uploads, LLM requests, and grading requests per user
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_usage_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action_type VARCHAR(50) NOT NULL,
        endpoint VARCHAR(500) NOT NULL,
        method VARCHAR(10) NOT NULL,
        status_code INTEGER,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT api_usage_logs_action_type_check CHECK (
          action_type IN ('file_upload', 'llm_request', 'grading_request', 'file_download')
        )
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user_id
      ON api_usage_logs(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_usage_logs_action_type
      ON api_usage_logs(action_type)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_usage_logs_created_at
      ON api_usage_logs(created_at)
    `);

    console.log('Database tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
    throw error;
  } finally {
    client.release();
  }
};
