import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { monitorEventLoopDelay } from 'perf_hooks';
import { logger, safeError } from './config/logger';
import { requestLogger } from './middleware/requestLogger';
import authRoutes from './routes/auth';
import rootRoutes from './routes/root';
import professorRoutes from './routes/professor';
import studentRoutes from './routes/student';
import chatRoutes from './routes/chat';
import materialSourceRoutes from './routes/materialSources';
import gradingAssistantRoutes from './routes/gradingAssistant';
import usageRoutes from './routes/usage';
import telemetryRoutes from './routes/telemetry';
import { connectDB, closeDB, pool } from './config/database';
import { checkRagReadiness } from './services/rag/readiness';
import { warmRagModels } from './services/rag/modelInference';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const telemetryTimer = setInterval(() => {
  logger.info({
    event: 'runtime_health',
    eventLoopP95Ms: Math.round(eventLoopDelay.percentile(95) / 1_000_000 * 100) / 100,
    poolWaiting: pool.waitingCount,
    poolIdle: pool.idleCount,
    poolTotal: pool.totalCount,
  });
  eventLoopDelay.reset();
}, 60_000);
telemetryTimer.unref();

app.use(requestLogger);

// Middleware
app.use(helmet());
app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Diagnostic routes expose development data and must never be reachable in production.
app.use((req, res, next) => {
  if ((/^\/api\/(debug|test)[-/]/.test(req.path) ||
       /^\/api\/(check-email|db-test)(\/|$)/.test(req.path)) &&
      (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEBUG_ROUTES !== 'true')) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

logger.info({ event: 'server_starting' });

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/root', rootRoutes);
app.use('/api/professor', professorRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/material-sources', materialSourceRoutes);
app.use('/api/grading-assistant', gradingAssistantRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/telemetry', telemetryRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ message: 'LMS API is running!' });
});

app.get('/api/ready', async (_req, res) => {
  const readiness = await checkRagReadiness();
  res.setHeader('Cache-Control', 'no-store');
  res.status(readiness.ready ? 200 : 503).json(readiness);
});

// Debug test endpoint
app.get('/api/debug-test', (req, res) => {
  const msg = '🧪 DEBUG TEST ENDPOINT HIT - CODE IS LOADED!';
  res.json({ message: msg, timestamp: new Date().toISOString() });
});

// Test course creation (without auth) - for debugging only
app.post('/api/test-create-course', async (req, res) => {
  try {
    const { pool } = await import('./config/database');
    const { title, description } = req.body;


    // Try to create a test course
    const result = await pool.query(
      'INSERT INTO courses (title, description, instructor_id) VALUES ($1, $2, $3) RETURNING *',
      [title || 'Test Course', description || 'Test Description', null]
    );


    res.json({
      success: true,
      message: 'Test course created successfully',
      course: result.rows[0]
    });
  } catch (error) {
    logger.error({ event: 'debug_course_create_failed', error: safeError(error) });
    res.status(500).json({
      success: false,
      error: 'Course creation failed',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
  }
});

// User check endpoint - checks if email exists
app.get('/api/check-email/:email', async (req, res) => {
  try {
    const { pool } = await import('./config/database');
    const { email } = req.params;


    // Exact match
    const exactMatch = await pool.query(
      'SELECT id, email, role, status FROM users WHERE email = $1',
      [email]
    );

    // Case-insensitive match
    const caseInsensitiveMatch = await pool.query(
      'SELECT id, email, role, status FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    // All users for debugging
    const allUsers = await pool.query('SELECT id, email FROM users ORDER BY id');

    res.json({
      success: true,
      email: email,
      exactMatch: exactMatch.rows.length > 0 ? exactMatch.rows[0] : null,
      caseInsensitiveMatch: caseInsensitiveMatch.rows.length > 0 ? caseInsensitiveMatch.rows[0] : null,
      allEmails: allUsers.rows.map(u => u.email),
      totalUsers: allUsers.rows.length
    });
  } catch (error) {
    logger.error({ event: 'debug_email_check_failed', error: safeError(error) });
    res.status(500).json({
      success: false,
      error: 'Email check failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Database connection test endpoint
app.get('/api/db-test', async (req, res) => {
  try {
    const { pool } = await import('./config/database');


    // Test basic query
    const result = await pool.query('SELECT NOW() as current_time, current_database() as db_name');

    // Count users
    const userCount = await pool.query('SELECT COUNT(*) as count FROM users');

    // Count courses
    const courseCount = await pool.query('SELECT COUNT(*) as count FROM courses');

    // Get all users with their emails
    const allUsers = await pool.query('SELECT id, full_name, email, role, status FROM users ORDER BY id');

    // Check specifically for Student1@gmail.com (case-insensitive)
    const student1Check = await pool.query(
      "SELECT id, email, role FROM users WHERE LOWER(email) = LOWER('Student1@gmail.com')"
    );


    res.json({
      success: true,
      message: 'Database connection successful',
      data: {
        currentTime: result.rows[0].current_time,
        database: result.rows[0].db_name,
        userCount: userCount.rows[0].count,
        courseCount: courseCount.rows[0].count,
        allUsers: allUsers.rows,
        student1Exists: student1Check.rows.length > 0,
        student1Data: student1Check.rows.length > 0 ? student1Check.rows[0] : null,
        env: {
          NODE_ENV: process.env.NODE_ENV,
          hasDatabaseUrl: !!process.env.DATABASE_URL,
          hasJwtSecret: !!process.env.JWT_SECRET,
          hasSeedPassword: !!process.env.SEED_DEFAULT_PASSWORD
        }
      }
    });
  } catch (error) {
    logger.error({ event: 'debug_database_check_failed', error: safeError(error) });
    res.status(500).json({
      success: false,
      error: 'Database connection failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Connect to database and start server
const startServer = async () => {
  try {
    await connectDB();
    void warmRagModels().catch(() => {
      console.error('Local RAG models could not warm up; readiness remains unavailable.');
    });

    const server = app.listen(PORT, () => {
      logger.info({ event: 'server_listening', port: PORT });
    });
    const shutdown = () => {
      clearInterval(telemetryTimer);
      eventLoopDelay.disable();
      server.close(() => {
        void closeDB().finally(() => {
          logger.flush();
          process.exit(0);
        });
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    logger.fatal({ event: 'server_start_failed', error: safeError(error) });
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  logger.error({ event: 'unhandled_rejection', error: safeError(reason) });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ event: 'uncaught_exception', error: safeError(error) });
  process.exitCode = 1;
});

startServer();
