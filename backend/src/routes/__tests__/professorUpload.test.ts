import express from 'express';
import type { Server } from 'http';
import * as CFB from 'cfb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ query: vi.fn(), upload: vi.fn(), intent: {} as any }));
vi.mock('../../config/database', () => ({ pool: {
  query: state.query, connect: async () => ({ query: state.query, release: () => {} }),
} }));
vi.mock('../../config/storage', () => ({ uploadImmutableFile: state.upload }));
vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { userId: 3, role: 'professor' }; next(); },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  requireApprovedProfessor: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../utils/usageLogger', () => ({ logUsage: vi.fn() }));
import router from '../professor';

const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
function presentation(): Buffer {
  const zip = CFB.utils.cfb_new();
  CFB.utils.cfb_add(zip, 'ppt/presentation.xml', Buffer.from('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'));
  CFB.utils.cfb_add(zip, '[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  return CFB.write(zip, { type: 'buffer', fileType: 'zip', compression: true });
}
function legacyPresentation(): Buffer {
  const compound = CFB.utils.cfb_new();
  CFB.utils.cfb_add(compound, 'PowerPoint Document', Buffer.from('Synthetic presentation stream'));
  return CFB.write(compound, { type: 'buffer', fileType: 'cfb' });
}

describe('professor multipart upload with native validation', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use('/professor', router);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/professor/materials`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.resetAllMocks();
    state.upload.mockResolvedValue('42');
    state.query.mockImplementation(async (sql: string, args: any[] = []) => {
      if (sql.includes('SELECT course_id')) return { rowCount: 1, rows: [{ course_id: 1 }] };
      if (sql.includes('INSERT INTO course_materials')) return { rowCount: 1, rows: [{ id: 17 }] };
      if (sql.includes('INSERT INTO material_upload_intents')) {
        state.intent = { id: args[0], material_id: args[1], version_id: args[2], object_name: args[3],
          expected_sha256: args[4], mime_type: args[5], byte_count: args[6], original_filename: args[7], status: 'pending' };
      }
      if (sql.includes('SELECT i.*')) return { rowCount: 1, rows: [state.intent] };
      if (sql.includes('INSERT INTO material_index_runs')) return { rowCount: 1, rows: [{ id: args[0], status: 'queued' }] };
      return { rowCount: 1, rows: [] };
    });
  });
  async function upload(buffer: Buffer, name = 'lecture.pptx', type = pptxMime): Promise<Response> {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(buffer)], { type }), name);
    return fetch(base, { method: 'POST', body: form });
  }
  it('accepts a PPTX archive and queues the immutable original', async () => {
    const response = await upload(presentation());
    expect(response.status).toBe(202);
    expect((await response.json() as any).materials[0].ingestion_status).toBe('queued');
    expect(state.upload).toHaveBeenCalledOnce();
  });
  it('accepts a real legacy OLE PPT container and queues the original', async () => {
    const response = await upload(legacyPresentation(), 'lecture.ppt', 'application/vnd.ms-powerpoint');
    expect(response.status).toBe(202);
    expect((await response.json() as any).materials[0].ingestion_status).toBe('queued');
    expect(state.upload).toHaveBeenCalledOnce();
  });
  it('returns the validation reason for a non-PPTX file instead of a generic 500', async () => {
    const response = await upload(Buffer.from('This is not a ZIP package.'));
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toBe('Invalid Office ZIP signature');
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO course_materials'))).toBe(false);
  });
  it('does not expose database error details in the upload response', async () => {
    state.query.mockRejectedValueOnce(Object.assign(new Error('private database details'), { code: 'XX000' }));
    const response = await upload(presentation());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private database details');
  });
});
