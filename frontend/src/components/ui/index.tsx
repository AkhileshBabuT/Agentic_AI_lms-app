import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, ThHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading = false, disabled, children, className = '', ...props }: ButtonProps) {
  return <button className={`ui-button ui-button--${variant} ui-button--${size} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{loading && <span className="ui-button__spinner" aria-hidden="true" />}{children}</button>;
}

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  label: string;
  icon: ReactNode;
  title?: string;
}

export function IconButton({ label, icon, title, ...props }: IconButtonProps) {
  return <Button aria-label={label} title={title ?? label} {...props}>{icon}</Button>;
}

export function Card({ className = '', children, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`ui-card ${className}`} {...props}>{children}</section>;
}

export function Badge({ tone = 'neutral', children, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={`ui-badge ui-tone--${tone} ${className}`} {...props}>{children}</span>;
}

export const StatusChip = Badge;

export interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function FormField({ label, hint, error, id, className = '', ...props }: FormFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return <div className={`ui-field ${className}`}><label htmlFor={inputId}>{label}</label><input id={inputId} aria-invalid={!!error} aria-describedby={[hint && `${inputId}-hint`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined} {...props} />{hint && <small id={`${inputId}-hint`}>{hint}</small>}{error && <small id={`${inputId}-error`} className="ui-field__error">{error}</small>}</div>;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Select({ label, hint, error, id, children, className = '', ...props }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  return <div className={`ui-field ${className}`}><label htmlFor={selectId}>{label}</label><select id={selectId} aria-invalid={!!error} aria-describedby={[hint && `${selectId}-hint`, error && `${selectId}-error`].filter(Boolean).join(' ') || undefined} {...props}>{children}</select>{hint && <small id={`${selectId}-hint`}>{hint}</small>}{error && <small id={`${selectId}-error`} className="ui-field__error">{error}</small>}</div>;
}

export interface TabItem { id: string; label: string; content: ReactNode; disabled?: boolean }
export function Tabs({ items, activeId, onChange, label }: { items: TabItem[]; activeId: string; onChange: (id: string) => void; label: string }) {
  const instanceId = useId();
  const active = items.find(item => item.id === activeId && !item.disabled) ?? items.find(item => !item.disabled);
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = items.filter(item => !item.disabled);
    const current = enabled.findIndex(item => item.id === items[index].id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    const target = enabled[next];
    if (target) { onChange(target.id); document.getElementById(`${instanceId}-tab-${target.id}`)?.focus(); }
  }
  return <div className="ui-tabs"><div role="tablist" aria-label={label} className="ui-tabs__list">{items.map((item, index) => <button key={item.id} type="button" role="tab" id={`${instanceId}-tab-${item.id}`} aria-selected={item.id === active?.id} aria-controls={`${instanceId}-panel-${item.id}`} tabIndex={item.id === active?.id ? 0 : -1} disabled={item.disabled} onClick={() => onChange(item.id)} onKeyDown={event => onKeyDown(event, index)}>{item.label}</button>)}</div>{active && <div className="ui-tabs__panel" role="tabpanel" id={`${instanceId}-panel-${active.id}`} aria-labelledby={`${instanceId}-tab-${active.id}`} tabIndex={0}>{active.content}</div>}</div>;
}

export interface DataColumn<T> { key: string; header: string; render: (item: T) => ReactNode; headerProps?: ThHTMLAttributes<HTMLTableCellElement> }
export function DataTable<T>({ columns, rows, rowKey, caption, emptyMessage = 'No results', className = '' }: { columns: DataColumn<T>[]; rows: T[]; rowKey: (item: T) => string | number; caption: string; emptyMessage?: string; className?: string }) {
  return <div className={`ui-table-scroll ${className}`}><table className="ui-table"><caption>{caption}</caption><thead><tr>{columns.map(column => <th scope="col" key={column.key} {...column.headerProps}>{column.header}</th>)}</tr></thead><tbody>{rows.length ? rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.key}>{column.render(row)}</td>)}</tr>) : <tr><td colSpan={columns.length}>{emptyMessage}</td></tr>}</tbody></table></div>;
}

function useOverlay(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const panel = panelRef.current;
    panel?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(node => node.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKeyDown); document.body.style.overflow = originalOverflow; previousFocus.current?.focus(); };
  }, [open, onClose]);
  return panelRef;
}

export function Dialog({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  const id = useId();
  const panelRef = useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(<div className="ui-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} tabIndex={-1} className="ui-dialog"><div className="ui-overlay__heading"><h2 id={`${id}-title`}>{title}</h2><IconButton variant="ghost" label="Close dialog" icon="×" onClick={onClose} /></div>{description && <p id={`${id}-description`}>{description}</p>}{children}</div></div>, document.body);
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const id = useId();
  const panelRef = useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(<div className="ui-overlay ui-overlay--drawer" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} className="ui-drawer"><div className="ui-overlay__heading"><h2 id={`${id}-title`}>{title}</h2><IconButton variant="ghost" label="Close navigation" icon="×" onClick={onClose} /></div>{children}</div></div>, document.body);
}

export function Skeleton({ label = 'Loading', lines = 3 }: { label?: string; lines?: number }) {
  return <div className="ui-skeleton" role="status" aria-label={label}>{Array.from({ length: lines }, (_, index) => <span key={index} aria-hidden="true" />)}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="ui-empty"><h2>{title}</h2>{description && <p>{description}</p>}{action}</div>;
}

export function InlineAlert({ tone = 'info', title, children, action }: { tone?: Exclude<Tone, 'neutral'>; title?: string; children: ReactNode; action?: ReactNode }) {
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`ui-alert ui-tone--${tone}`}><div>{title && <strong>{title}</strong>}<div>{children}</div></div>{action}</div>;
}
