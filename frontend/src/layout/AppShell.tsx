import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Drawer, IconButton } from '../components/ui';
import { PrimaryNavigation } from './PrimaryNavigation';
import type { AppRole, NavigationItem } from './PrimaryNavigation';
import './shell.css';

export interface AppShellProps { children: ReactNode; navigation?: NavigationItem[] }

export function AppShell({ children, navigation }: AppShellProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  if (!user) return null;
  const role: AppRole = user.role === 'root' || user.role === 'professor' ? user.role : 'student';
  function signOut() { logout(); navigate('/login', { replace: true }); }
  return <div className={`app-shell${sidebarCollapsed ? " app-shell--collapsed" : ""}`}><a className="app-shell__skip" href="#main-content">Skip to main content</a><header className="app-shell__topbar"><div className="app-shell__topbar-inner"><IconButton className="app-shell__menu-button" variant="ghost" icon={<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h16M4 12h16M4 18h16" /></svg>} label="Open navigation" aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(true)} /><IconButton className="app-shell__desktop-toggle" variant="ghost" icon={<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h16M4 12h16M4 18h16" /></svg>} label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!sidebarCollapsed} aria-controls="desktop-navigation" onClick={() => setSidebarCollapsed(value => !value)} /><Link to="/dashboard" className="app-shell__brand"><span className="app-shell__brand-mark" aria-hidden="true">a</span><span>agentic LMS</span></Link><div className="app-shell__account"><span className="app-shell__account-name" title={user.email}>{user.fullName}</span><span className="app-shell__account-role">{role === 'root' ? 'Administrator' : role === 'professor' ? 'Professor' : 'Student'}</span><button type="button" className="app-shell__logout" onClick={signOut}>Sign out</button></div></div></header><div className="app-shell__body"><aside id="desktop-navigation" className="app-shell__sidebar"><PrimaryNavigation role={role} items={navigation} /><div className="app-shell__sidebar-footer">Virginia Tech</div></aside><main id="main-content" className="app-shell__main" tabIndex={-1}>{children}</main></div><div id="mobile-navigation"><Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Navigation"><PrimaryNavigation role={role} items={navigation} onNavigate={() => setMenuOpen(false)} /><div className="app-shell__drawer-account"><strong>{user.fullName}</strong><span>{user.email}</span><button type="button" className="app-shell__logout" onClick={signOut}>Sign out</button></div></Drawer></div></div>;
}

export default AppShell;
