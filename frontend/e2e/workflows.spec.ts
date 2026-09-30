import { expect, test } from '@playwright/test';
import { seedSession, stubApi } from './fixtures';

test('professor upload displays accepted indexing status', async ({ page }) => {
  await stubApi(page, 'professor');
  await seedSession(page, 'professor');
  let uploaded = false;
  await page.route(/\/api\/professor\/materials(?:\?.*)?$/, route => {
    if (route.request().method() === 'POST') {
      uploaded = true;
      return route.fulfill({ status: 202, json: { materials: [{ id: 501, ingestion_status: 'queued' }] } });
    }
    return route.fulfill({ json: { materials: uploaded ? [{ id: 501, file_name: 'synthetic-notes.txt', file_size: 23, uploaded_at: '2026-01-01T00:00:00Z', ingestion_status: 'queued' }] : [] } });
  });
  await page.route('**/api/professor/folders**', route => route.fulfill({ json: { folders: [], page: { hasMore: false, nextCursor: null } } }));
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Course Materials' }).click();
  await expect(page.getByText('No course materials uploaded yet')).toBeVisible();
  await page.locator('#file-upload').setInputFiles({ name: 'synthetic-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic course material') });
  await expect(page.getByText('synthetic-notes.txt')).toBeVisible();
  await expect(page.getByText('Waiting to index')).toBeVisible();
  expect(uploaded).toBe(true);
});

test('student submits an assignment and sees the saved answer', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  let submitted = false;
  await page.route(/\/api\/student\/assignments\/901(?:\/submit)?$/, route => {
    if (route.request().method() === 'POST') {
      submitted = true;
      return route.fulfill({ json: { message: 'submitted' } });
    }
    return route.fulfill({ json: { assignment: { id: 901, course_id: 101, title: 'Synthetic reflection', points: 10, description: 'Use the course material.', submission: submitted ? { id: 902, submission_text: 'A synthetic answer.', submitted_at: '2026-01-01T00:00:00Z', grade: null, files: [] } : null } } });
  });
  await page.goto('/assignments/901');
  await page.getByPlaceholder('Enter your answer here...').fill('A synthetic answer.');
  await page.getByRole('button', { name: 'Submit Assignment' }).click();
  await expect(page.getByText('Assignment submitted successfully')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Answer:' }).locator('..').getByText('A synthetic answer.')).toBeVisible();
  expect(submitted).toBe(true);
});

test('historical chat answer shows only authorized citation details', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  await page.route('**/api/chat/sessions/77', route => route.fulfill({ json: { session: { id: 77, course_name: 'Synthetic Physics', agent_name: 'Course assistant', agent_description: 'Grounded tutor', session_name: 'Study session', status: 'active' } } }));
  await page.route('**/api/chat/sessions/77/messages', route => route.fulfill({ json: { messages: [
    { id: 701, session_id: 77, sender_type: 'student', content: 'What is inertia?', message_metadata: {}, created_at: '2026-01-01T12:00:00Z' },
    { id: 702, session_id: 77, sender_type: 'agent', content: 'Inertia describes resistance to changes in motion. [1]', message_metadata: { ragPipelineVersion: 'native-v2', answerStatus: 'supported' }, created_at: '2026-01-01T12:01:00Z', sources: [{ citationNumber: 1, evidenceId: 'e1', chunkId: 'chunk-1', materialId: 501, materialName: 'Synthetic notes', versionId: 'v1', runId: 'r1', excerpt: 'Objects resist changes in their motion.', locator: { page: 2 }, sourceType: 'course_material' }] },
  ] } }));
  await page.goto('/chat/77');
  await expect(page.getByText('Inertia describes resistance to changes in motion.')).toBeVisible();
  await page.getByRole('button', { name: /1 reference/ }).click();
  await expect(page.getByText('Objects resist changes in their motion.')).toBeVisible();
  await expect(page.getByText('Page 2')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open supporting passage' })).toHaveAttribute('href', '/material-source/chunk-1');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Supporting course sources' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: /1 reference/ })).toBeFocused();
});

test('streamed chat reconciles the question and shows a cited answer', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  await page.route('**/api/chat/sessions/77', route => route.fulfill({ json: { session: { id: 77, course_name: 'Synthetic Physics', agent_name: 'Course assistant', agent_description: 'Grounded tutor', session_name: 'Study session', status: 'active' } } }));
  await page.route('**/api/chat/sessions/77/messages', route => route.fulfill({ json: { messages: [] } }));
  let requestKey = '';
  await page.route('**/api/chat/sessions/77/messages/stream', route => {
    requestKey = route.request().headers()['idempotency-key'];
    const student = { id: 801, session_id: 77, sender_type: 'student', content: 'Explain inertia', message_metadata: {}, created_at: '2026-01-01T12:00:00Z' };
    const agent = { id: 802, session_id: 77, sender_type: 'agent', content: 'Inertia resists a change in motion. [1]', message_metadata: { ragPipelineVersion: 'native-v2', answerStatus: 'supported' }, created_at: '2026-01-01T12:01:00Z', sources: [{ citationNumber: 1, chunkId: 'chunk-1', materialName: 'Synthetic notes', excerpt: 'Objects resist changes in motion.', locator: { page: 2 }, sourceType: 'course_material' }] };
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frame('accepted', { studentMessage: student }) + frame('stage', { stage: 'validating_citations' }) + frame('complete', { agentMessage: agent }) });
  });
  await page.goto('/chat/77');
  await page.getByPlaceholder('Ask me anything about Synthetic Physics...').fill('Explain inertia');
  await page.getByPlaceholder('Ask me anything about Synthetic Physics...').press('Enter');
  await expect(page.getByText('Inertia resists a change in motion.')).toBeVisible();
  await expect(page.getByText('Explain inertia')).toHaveCount(1);
  await page.getByRole('button', { name: /1 reference/ }).click();
  await expect(page.getByText('Objects resist changes in motion.')).toBeVisible();
  expect(requestKey).toMatch(/^[a-f0-9-]{36}$/);
});

test('professor grade dialog warns before discarding unsaved work', async ({ page }) => {
  await stubApi(page, 'professor');
  await seedSession(page, 'professor');
  await page.route('**/api/professor/assignments/901', route => route.fulfill({ json: { assignment: { id: 901, course_id: 101, title: 'Synthetic reflection', description: 'Reflect on the notes.', points: 10, due_date: null } } }));
  await page.route('**/api/professor/assignments/901/files', route => route.fulfill({ json: { files: [], page: { nextCursor: null, hasMore: false } } }));
  await page.route(/\/api\/professor\/assignments\/901\/submissions(?:\?.*)?$/, route => route.fulfill({ json: { submissions: [{ id: 902, student_id: 8, student_name: 'Synthetic Student', student_email: 'student@example.test', submission_text: 'Synthetic response.', grade: null, feedback: null, submitted_at: '2026-01-01T12:00:00Z', graded_at: null, files: [], tentative_grade: null }], page: { nextCursor: null, hasMore: false } } }));
  await page.route('**/api/grading-assistant/rubric/901', route => route.fulfill({ status: 404, json: { error: 'No rubric' } }));
  await page.goto('/professor/assignments/901');
  await page.getByRole('button', { name: 'Grade Manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Grade Submission - Synthetic Student' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Grade (out of 10)').fill('8');
  page.once('dialog', prompt => void prompt.dismiss());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  page.once('dialog', prompt => void prompt.accept());
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
