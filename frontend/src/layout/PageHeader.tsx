import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface Breadcrumb { label: string; to?: string }
export interface PageHeaderProps { title: string; description?: string; breadcrumbs?: Breadcrumb[]; action?: ReactNode; secondaryActions?: ReactNode }

export function PageHeader({ title, description, breadcrumbs = [], action, secondaryActions }: PageHeaderProps) {
  return <header className="app-page-header">{breadcrumbs.length > 0 && <nav aria-label="Breadcrumb" className="app-page-header__breadcrumbs"><ol>{breadcrumbs.map((crumb, index) => <li key={`${crumb.label}-${index}`}>{crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}</li>)}</ol></nav>}<div className="app-page-header__row"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{(action || secondaryActions) && <div className="app-page-header__actions">{secondaryActions}{action}</div>}</div></header>;
}
