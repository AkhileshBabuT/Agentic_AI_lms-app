import { Link, useLocation } from 'react-router-dom';

export type AppRole = 'student' | 'professor' | 'root';
export interface NavigationItem { label: string; to: string; roles: readonly AppRole[]; end?: boolean }

// Existing dashboards own course, material, assignment, and administration tabs.
// Supply dedicated routes through `items` when those workflows receive stable URLs.
const defaultNavigation: NavigationItem[] = [
  { label: 'Dashboard', to: '/dashboard', roles: ['student', 'professor', 'root'], end: true },
  { label: 'My courses', to: '/dashboard?view=my-courses', roles: ['student'] },
  { label: 'Explore courses', to: '/dashboard?view=all-courses', roles: ['student'] },
  { label: 'Students', to: '/dashboard?view=students', roles: ['professor'] },
  { label: 'Materials', to: '/dashboard?view=materials', roles: ['professor'] },
  { label: 'Assignments', to: '/dashboard?view=assignments', roles: ['professor'] },
  { label: 'Administration', to: '/dashboard?view=pending', roles: ['root'] },
  { label: 'Users', to: '/dashboard?view=users', roles: ['root'] },
  { label: 'Courses', to: '/dashboard?view=courses', roles: ['root'] },
  { label: 'AI tutor', to: '/ai-agent-hub', roles: ['student', 'professor', 'root'] },
];

export function PrimaryNavigation({ role, items = defaultNavigation, onNavigate }: { role: AppRole; items?: NavigationItem[]; onNavigate?: () => void }) {
  const location = useLocation();
  const visible = items.filter(item => item.roles.includes(role));
  return <nav aria-label="Primary navigation" className="app-shell__nav">{visible.map(item => {
    const [path, search] = item.to.split('?');
    const active = location.pathname === path && location.search === (search ? `?${search}` : '');
    return <Link key={item.to} to={item.to} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={`app-shell__nav-link${active ? ' app-shell__nav-link--active' : ''}`}>{item.label}</Link>;
  })}</nav>;
}
