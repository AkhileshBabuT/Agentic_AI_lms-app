import type { Page } from '@playwright/test';

export type Role = 'student' | 'professor' | 'root';

export const users: Record<Role, { id: number; fullName: string; email: string; role: Role; status: string }> = {
  student: { id: 11, fullName: 'Test Student', email: 'student@example.test', role: 'student', status: 'active' },
  professor: { id: 22, fullName: 'Test Professor', email: 'professor@example.test', role: 'professor', status: 'approved' },
  root: { id: 33, fullName: 'Test Admin', email: 'root@example.test', role: 'root', status: 'active' },
};

export async function stubApi(page: Page, role: Role = 'student') {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    if (path === '/auth/login' && request.method() === 'POST') {
      return route.fulfill({ json: { token: `synthetic-${role}-token`, user: users[role] } });
    }
    const responses: Record<string, unknown> = {
      '/student/courses': { courses: [{ id: 101, title: 'Synthetic Physics', description: 'Course fixture', instructor_name: 'Test Professor' }] },
      '/student/my-courses': { courses: [] },
      '/student/courses/101': { course: { id: 101, title: 'Synthetic Physics', description: 'Course fixture', instructor_name: 'Test Professor' } },
      '/student/courses/101/assignments': { assignments: [] },
      '/student/courses/101/announcements': { announcements: [] },
      '/professor/course': { course: { id: 101, title: 'Synthetic Physics', description: 'Course fixture' } },
      '/professor/students': { students: [] },
      '/root/stats': { stats: { users: { student: 1, professor: 1, root: 1 }, totalCourses: 1, totalEnrollments: 1, pendingProfessors: 0 } },
      '/root/professors/pending': { professors: [] },
    };
    if (path in responses) return route.fulfill({ json: responses[path] });
    return route.fulfill({ status: 404, json: { error: 'Synthetic fixture not defined' } });
  });
}

export async function seedSession(page: Page, role: Role) {
  await page.addInitScript(user => {
    localStorage.setItem('token', `synthetic-${user.role}-token`);
    localStorage.setItem('user', JSON.stringify(user));
  }, users[role]);
}
