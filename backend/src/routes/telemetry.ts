import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { logger } from '../config/logger';

const router = Router();
router.post('/vitals', authenticate, (req, res) => {
  const { name, value, rating, id } = req.body ?? {};
  if (!['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].includes(name) ||
      typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000 ||
      (rating !== undefined && !['good', 'needs-improvement', 'poor'].includes(rating)) ||
      (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id)))) {
    return res.status(400).json({ error: 'Invalid metric' });
  }
  logger.info({ event: 'web_vital', name, value, rating, id });
  return res.status(204).end();
});

export default router;
