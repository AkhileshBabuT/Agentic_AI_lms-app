"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv_1 = __importDefault(require("dotenv"));
const perf_hooks_1 = require("perf_hooks");
const logger_1 = require("./config/logger");
const requestLogger_1 = require("./middleware/requestLogger");
const auth_1 = __importDefault(require("./routes/auth"));
const root_1 = __importDefault(require("./routes/root"));
const professor_1 = __importDefault(require("./routes/professor"));
const student_1 = __importDefault(require("./routes/student"));
const chat_1 = __importDefault(require("./routes/chat"));
const materialSources_1 = __importDefault(require("./routes/materialSources"));
const gradingAssistant_1 = __importDefault(require("./routes/gradingAssistant"));
const usage_1 = __importDefault(require("./routes/usage"));
const telemetry_1 = __importDefault(require("./routes/telemetry"));
const database_1 = require("./config/database");
const readiness_1 = require("./services/rag/readiness");
const modelInference_1 = require("./services/rag/modelInference");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
const eventLoopDelay = (0, perf_hooks_1.monitorEventLoopDelay)({ resolution: 20 });
eventLoopDelay.enable();
const telemetryTimer = setInterval(() => {
    logger_1.logger.info({
        event: 'runtime_health',
        eventLoopP95Ms: Math.round(eventLoopDelay.percentile(95) / 1000000 * 100) / 100,
        poolWaiting: database_1.pool.waitingCount,
        poolIdle: database_1.pool.idleCount,
        poolTotal: database_1.pool.totalCount,
    });
    eventLoopDelay.reset();
}, 60000);
telemetryTimer.unref();
app.use(requestLogger_1.requestLogger);
// Middleware
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Diagnostic routes expose development data and must never be reachable in production.
app.use((req, res, next) => {
    if ((/^\/api\/(debug|test)[-/]/.test(req.path) ||
        /^\/api\/(check-email|db-test)(\/|$)/.test(req.path)) &&
        (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEBUG_ROUTES !== 'true')) {
        return res.status(404).json({ error: 'Not found' });
    }
    next();
});
logger_1.logger.info({ event: 'server_starting' });
// Routes
app.use('/api/auth', auth_1.default);
app.use('/api/root', root_1.default);
app.use('/api/professor', professor_1.default);
app.use('/api/student', student_1.default);
app.use('/api/chat', chat_1.default);
app.use('/api/material-sources', materialSources_1.default);
app.use('/api/grading-assistant', gradingAssistant_1.default);
app.use('/api/usage', usage_1.default);
app.use('/api/telemetry', telemetry_1.default);
// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ message: 'LMS API is running!' });
});
app.get('/api/ready', async (_req, res) => {
    const readiness = await (0, readiness_1.checkRagReadiness)();
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
        const { pool } = await Promise.resolve().then(() => __importStar(require('./config/database')));
        const { title, description } = req.body;
        // Try to create a test course
        const result = await pool.query('INSERT INTO courses (title, description, instructor_id) VALUES ($1, $2, $3) RETURNING *', [title || 'Test Course', description || 'Test Description', null]);
        res.json({
            success: true,
            message: 'Test course created successfully',
            course: result.rows[0]
        });
    }
    catch (error) {
        logger_1.logger.error({ event: 'debug_course_create_failed', error: (0, logger_1.safeError)(error) });
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
        const { pool } = await Promise.resolve().then(() => __importStar(require('./config/database')));
        const { email } = req.params;
        // Exact match
        const exactMatch = await pool.query('SELECT id, email, role, status FROM users WHERE email = $1', [email]);
        // Case-insensitive match
        const caseInsensitiveMatch = await pool.query('SELECT id, email, role, status FROM users WHERE LOWER(email) = LOWER($1)', [email]);
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
    }
    catch (error) {
        logger_1.logger.error({ event: 'debug_email_check_failed', error: (0, logger_1.safeError)(error) });
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
        const { pool } = await Promise.resolve().then(() => __importStar(require('./config/database')));
        // Test basic query
        const result = await pool.query('SELECT NOW() as current_time, current_database() as db_name');
        // Count users
        const userCount = await pool.query('SELECT COUNT(*) as count FROM users');
        // Count courses
        const courseCount = await pool.query('SELECT COUNT(*) as count FROM courses');
        // Get all users with their emails
        const allUsers = await pool.query('SELECT id, full_name, email, role, status FROM users ORDER BY id');
        // Check specifically for Student1@gmail.com (case-insensitive)
        const student1Check = await pool.query("SELECT id, email, role FROM users WHERE LOWER(email) = LOWER('Student1@gmail.com')");
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
    }
    catch (error) {
        logger_1.logger.error({ event: 'debug_database_check_failed', error: (0, logger_1.safeError)(error) });
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
        await (0, database_1.connectDB)();
        void (0, modelInference_1.warmRagModels)().catch(() => {
            console.error('Local RAG models could not warm up; readiness remains unavailable.');
        });
        const server = app.listen(PORT, () => {
            logger_1.logger.info({ event: 'server_listening', port: PORT });
        });
        const shutdown = () => {
            clearInterval(telemetryTimer);
            eventLoopDelay.disable();
            server.close(() => {
                void (0, database_1.closeDB)().finally(() => {
                    logger_1.logger.flush();
                    process.exit(0);
                });
            });
        };
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
    }
    catch (error) {
        logger_1.logger.fatal({ event: 'server_start_failed', error: (0, logger_1.safeError)(error) });
        process.exit(1);
    }
};
// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error({ event: 'unhandled_rejection', error: (0, logger_1.safeError)(reason) });
});
// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger_1.logger.fatal({ event: 'uncaught_exception', error: (0, logger_1.safeError)(error) });
    process.exitCode = 1;
});
startServer();
//# sourceMappingURL=index.js.map