import { expect, test } from '@playwright/test';
import { seedSession, stubApi } from './fixtures';

test('student loads the next assignment page on demand', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  const cursors: Array<string | null> = [];
  await page.route(/\/api\/student\/courses\/101\/assignments(?:\?.*)?$/, route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    const assignments = cursor
      ? [{ id: 902, title: 'Second assignment', points: 10 }]
      : [{ id: 901, title: 'First assignment', points: 10 }];
    return route.fulfill({ json: { items: assignments, assignments, page: { hasMore: !cursor, nextCursor: cursor ? null : 'next-assignment-page' } } });
  });
  await page.goto('/courses/101');
  await page.getByRole('button', { name: 'Assignments' }).click();
  await expect(page.getByText('First assignment')).toBeVisible();
  await expect(page.getByText('Second assignment')).not.toBeVisible();
  await page.getByRole('button', { name: 'Load more assignments' }).click();
  await expect(page.getByText('Second assignment')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more assignments' })).not.toBeVisible();
  expect(cursors).toEqual([null, 'next-assignment-page']);
});

test('student loads additional folders and materials independently', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  await page.route(/\/api\/student\/courses\/101\/folders(?:\?.*)?$/, route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const folders = cursor ? [{ id: 22, name: 'Week two', created_at: '2026-01-02T00:00:00Z' }]
      : [{ id: 21, name: 'Week one', created_at: '2026-01-01T00:00:00Z' }];
    return route.fulfill({ json: { items: folders, folders, page: { hasMore: !cursor, nextCursor: cursor ? null : 'next-folder-page' } } });
  });
  await page.route(/\/api\/student\/courses\/101\/materials(?:\?.*)?$/, route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const materials = cursor ? [{ id: 52, file_name: 'second.txt', file_size: 20, uploaded_at: '2026-01-02T00:00:00Z', ingestion_status: 'ready' }]
      : [{ id: 51, file_name: 'first.txt', file_size: 20, uploaded_at: '2026-01-01T00:00:00Z', ingestion_status: 'ready' }];
    return route.fulfill({ json: { items: materials, materials, page: { hasMore: !cursor, nextCursor: cursor ? null : 'next-material-page' } } });
  });
  await page.goto('/courses/101');
  await page.getByRole('button', { name: 'Materials' }).click();
  await expect(page.getByText('first.txt')).toBeVisible();
  await expect(page.getByText('Week one')).toBeVisible();
  await page.getByRole('button', { name: 'Load more folders' }).click();
  await expect(page.getByText('Week two')).toBeVisible();
  await page.getByRole('button', { name: 'Load more materials' }).click();
  await expect(page.getByText('second.txt')).toBeVisible();
});

test('student loads older announcements from the next page', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  await page.route(/\/api\/student\/courses\/101\/announcements(?:\?.*)?$/, route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const announcements = cursor
      ? [{ id: 82, title: 'Older announcement', content: 'Second page notice', author: 'Test Professor', date: '2026-01-01' }]
      : [{ id: 81, title: 'Latest announcement', content: 'First page notice', author: 'Test Professor', date: '2026-01-02' }];
    return route.fulfill({ json: { items: announcements, announcements, page: { hasMore: !cursor, nextCursor: cursor ? null : 'next-announcement-page' } } });
  });
  await page.goto('/courses/101');
  await page.getByRole('button', { name: 'Announcements' }).click();
  await expect(page.getByText('Latest announcement')).toBeVisible();
  await page.getByRole('button', { name: 'Load more announcements' }).click();
  await expect(page.getByText('Older announcement')).toBeVisible();
});
