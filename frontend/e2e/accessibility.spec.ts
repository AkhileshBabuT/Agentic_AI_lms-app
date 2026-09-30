import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seedSession, stubApi, type Role } from './fixtures';

const screens: Array<{ name: string; role?: Role; path: string; heading: string }> = [
  { name: 'login', path: '/login', heading: 'Welcome Back' },
  { name: 'student workspace', role: 'student', path: '/dashboard', heading: 'Learning workspace' },
  { name: 'course detail', role: 'student', path: '/courses/101', heading: 'Synthetic Physics' },
  { name: 'professor workspace', role: 'professor', path: '/dashboard', heading: 'Teaching workspace' },
  { name: 'administration workspace', role: 'root', path: '/dashboard', heading: 'Administration workspace' },
];

for (const screen of screens) {
  test(`${screen.name} has no serious or critical axe findings`, async ({ page }) => {
    await stubApi(page, screen.role ?? 'student');
    if (screen.role) await seedSession(page, screen.role);
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { name: screen.heading, exact: true }).first()).toBeVisible();

    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const severe = result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical');
    expect(severe.map(violation => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
  });
}

for (const width of [360, 768, 1280, 1440]) {
  test(`student workspace fits ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page, 'student');
    await seedSession(page, 'student');
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Learning workspace' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
