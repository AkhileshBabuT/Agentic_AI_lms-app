import { NavLink } from 'react-router-dom';

export type AppRole = 'student' | 'professor' | 'root';
export interface NavigationItem { label: string; to: string; roles: readonly AppRole[]; end?: boolean }

// Existing dashboards own course, material, assignment, and administration tabs.
// Supply dedicated routes through `items` when those workflows receive stable URLs.
const defaultNavigation: NavigationItem[] = [
  { label: 'Dashboard', to: '/dashboard', roles: ['student', 'professor', 'root'], end: true },
  { label: 'AI tutor', to: '/ai-agent-hub', roles: ['student', 'professor', 'root'] },
];

export function PrimaryNavigation({ role, items = defaultNavigation, onNavigate }: { role: AppRole; items?: NavigationItem[]; onNavigate?: () => void }) {
  const visible = items.filter(item => item.roles.includes(role));
  return <nav aria-label="Primary navigation" className="app-shell__nav">{visible.map(item => <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate} className={({ isActive }) => `app-shell__nav-link${isActive ? ' app-shell__nav-link--active' : ''}`}>{item.label}</NavLink>)}</nav>;
}
