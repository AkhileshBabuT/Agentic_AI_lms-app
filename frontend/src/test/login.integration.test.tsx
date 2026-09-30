// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { AuthProvider } from '../contexts/AuthContext';
import Login from '../pages/Login';

const syntheticUser = { id: 11, fullName: 'Test Student', email: 'student@example.test', role: 'student' };
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

function renderLogin() {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<h1>Student workspace</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function submitLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'student@example.test');
  await user.type(screen.getByLabelText('Password'), 'synthetic-password');
  fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form')!);
}

describe('login boundary', () => {
  it('shows a server rejection and lets the student retry successfully', async () => {
    server.use(http.post('http://localhost:5000/api/auth/login', () => HttpResponse.json({ error: 'Incorrect credentials' }, { status: 401 })));
    renderLogin();
    await submitLogin();
    expect(await screen.findByText('Incorrect credentials')).toBeTruthy();
    expect(localStorage.getItem('token')).toBeNull();

    server.use(http.post('http://localhost:5000/api/auth/login', () => HttpResponse.json({ user: syntheticUser, token: 'synthetic-token' })));
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('heading', { name: 'Student workspace' })).toBeTruthy();
    expect(localStorage.getItem('token')).toBe('synthetic-token');
  });
});
