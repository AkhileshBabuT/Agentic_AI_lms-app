import { Router, Request, Response } from 'express';
import { authenticate, requireActiveStatus } from '../middleware/auth';
import { getAuthorizedAnswerRecord, getAuthorizedSavedContentSources, resolveMaterialSource } from '../services/rag/CitationService';

const router = Router();
router.use(authenticate, requireActiveStatus);
router.get('/saved/:contentId', async (req: Request, res: Response) => {
  const id = Number(req.params.contentId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid saved content ID' });
  try {
    const record = await getAuthorizedSavedContentSources(id, req.user!.userId, req.user!.role);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(record);
  } catch (error: any) {
    return res.status(error.status ?? 500).json({ error: 'Unable to load saved answer references' });
  }
});
router.get('/answers/:messageId', async (req: Request, res: Response) => {
  const id = Number(req.params.messageId);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid answer ID' });
  try {
    const result = await getAuthorizedAnswerRecord(id, req.user!.userId, req.user!.role);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error: any) { return res.status(error.status ?? 500).json({ error: error.status === 403 ? error.message : 'Unable to load answer references' }); }
});
router.get('/:chunkId', async (req: Request, res: Response) => {
  const chunkId = String(req.params.chunkId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chunkId)) return res.status(400).json({ error: 'Invalid source ID' });
  try {
    const result = await resolveMaterialSource(chunkId, req.user!.userId, req.user!.role);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error: any) { return res.status(error.status ?? 500).json({ error: error.status === 403 ? error.message : 'Unable to open source document' }); }
});
export default router;
