import { expect, test } from '@playwright/test';
import { seedSession, stubApi, type Role } from './fixtures';

for (const role of ['student', 'professor', 'root'] as Role[]) {
  for (const width of [360, 768, 1280, 1440]) {
    test(`${role} workspace fits ${width}px and opens a role section`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page, role);
      await seedSession(page, role);
      await page.goto('/dashboard');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      const menuButton = page.getByRole('button', { name: 'Open navigation' });
      if (width <= 768) {
        await menuButton.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
        await expect(menuButton).toBeFocused();
        await menuButton.click();
      }

      const [label, view] = role === 'student' ? ['My courses', 'my-courses'] : role === 'professor' ? ['Materials', 'materials'] : ['Administration', 'pending'];
      await page.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`view=${view}`));
      if (width <= 768) await menuButton.click();
      await expect(page.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
      const sectionOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(sectionOverflow).toBeLessThanOrEqual(1);
    });
  }
}

test('student courses continue through the cursor', async ({ page }) => {
  await stubApi(page, 'student');
  await page.route('**/api/student/my-courses**', async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await route.fulfill({ json: cursor ? { courses: [{ id: 102, title: 'Second course', description: '', instructor_name: 'Test Professor' }], page: { hasMore: false, nextCursor: null } } : { courses: [{ id: 101, title: 'First course', description: '', instructor_name: 'Test Professor' }], page: { hasMore: true, nextCursor: 'next' } } });
  });
  await seedSession(page, 'student');
  await page.goto('/dashboard?view=my-courses');
  await expect(page.getByRole('heading', { name: 'First course' })).toBeVisible();
  await page.getByRole('button', { name: 'Load more enrolled courses' }).click();
  await expect(page.getByRole('heading', { name: 'Second course' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more enrolled courses' })).toHaveCount(0);
});

test('professor material polling stops when indexing completes', async ({ page }) => {
  await page.clock.install();
  await stubApi(page, 'professor');
  let materialReads = 0;
  let ready = false;
  await page.route('**/api/professor/materials**', async route => {
    materialReads += 1;
    await route.fulfill({ json: { materials: [{ id: 501, file_name: 'Lecture notes.pdf', file_size: 2000, uploaded_at: '2026-09-30T12:00:00Z', ingestion_status: ready ? 'ready' : 'queued' }], page: { hasMore: false, nextCursor: null } } });
  });
  await page.route('**/api/professor/folders**', route => route.fulfill({ json: { folders: [], page: { hasMore: false, nextCursor: null } } }));
  await seedSession(page, 'professor');
  await page.goto('/dashboard?view=materials');
  await expect(page.getByText('Checking 1 active attachment for updates.')).toBeVisible();
  const initialReads = materialReads;
  ready = true;
  await page.clock.fastForward(3000);
  await expect(page.getByText('Available for answers')).toBeVisible();
  expect(materialReads).toBe(initialReads + 1);
  await page.clock.fastForward(60000);
  expect(materialReads).toBe(initialReads + 1);
});

for (const role of ['student', 'professor', 'root'] as const) {
  test(`${role} navigation collapses and restores across a full-width workspace`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await stubApi(page, role);
    await seedSession(page, role);
    await page.goto('/dashboard');
    const rail = page.locator('#desktop-navigation');
    const main = page.locator('#main-content');
    await expect(rail).toBeVisible();
    const expandedWidth = await main.evaluate(element => element.getBoundingClientRect().width);
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await expect(rail).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
    const collapsedWidth = await main.evaluate(element => element.getBoundingClientRect().width);
    expect(collapsedWidth).toBeGreaterThan(expandedWidth);
    expect(collapsedWidth).toBe(1920);
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
    await expect(rail).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Collapse navigation', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });
}
