import { expect, test } from '@playwright/test';
import { seedSession, stubApi } from './fixtures';

test('protected course navigation redirects guests to login', async ({ page }) => {
  await stubApi(page);
  await page.goto('/courses/101');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome Back' })).toBeVisible();
});

test('student login opens the student dashboard and permits course navigation', async ({ page }) => {
  await stubApi(page, 'student');
  await page.goto('/login');
  await page.getByLabel('Email').fill('student@example.test');
  await page.getByLabel('Password').fill('synthetic-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Learning workspace' })).toBeVisible();
  await page.goto('/courses/101');
  await expect(page.getByRole('heading', { name: 'Synthetic Physics' })).toBeVisible();
});

test('root session loads root workflow on a direct protected URL', async ({ page }) => {
  await stubApi(page, 'root');
  await seedSession(page, 'root');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Administration workspace' })).toBeVisible();
});

test('professor session loads professor workflow on refresh', async ({ page }) => {
  await stubApi(page, 'professor');
  await seedSession(page, 'professor');
  await page.goto('/dashboard');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Teaching workspace' })).toBeVisible();
});

test('revoked source access shows a safe denial and retry action', async ({ page }) => {
  await stubApi(page, 'student');
  await seedSession(page, 'student');
  await page.route('**/api/material-sources/revoked-chunk', route => route.fulfill({ status: 403, json: { error: 'forbidden' } }));
  await page.goto('/material-source/revoked-chunk');
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('root approves a pending professor through the visible queue', async ({ page }) => {
  await stubApi(page, 'root');
  await seedSession(page, 'root');
  let approved = false;
  await page.route(/\/api\/root\/professors\/pending(?:\?.*)?$/, route => route.fulfill({ json: { professors: approved ? [] : [{ id: 44, full_name: 'Test Applicant', email: 'applicant@example.test', status: 'pending', created_at: '2026-01-01T00:00:00Z' }] } }));
  await page.route('**/api/root/professors/44/status', route => { approved = true; return route.fulfill({ json: { professor: { id: 44, status: 'approved' } } }); });
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Pending Professors' }).click();
  await expect(page.getByText('Test Applicant')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Professor approved successfully')).toBeVisible();
  await expect(page.getByText('Test Applicant')).not.toBeVisible();
  expect(approved).toBe(true);
});
