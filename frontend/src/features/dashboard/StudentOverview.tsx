import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { courseQueries } from '../../data/queries';
import { Card, InlineAlert, Skeleton } from '../../components/ui';
import './dashboard.css';

export interface StudentCourse { id: number; title: string; description: string; instructor_name: string; enrolled_students_count?: number; is_enrolled?: boolean }
interface Assignment { id: number; title: string; due_date: string | null }
interface Announcement { id: number; title: string; created_at: string }
interface Detail { course: { assignments?: Assignment[]; announcements?: Announcement[] } }

export function StudentOverview({ courses, onBrowse, onViewAll }: { courses: StudentCourse[]; onBrowse: () => void; onViewAll: () => void }) {
  const previewCourses = courses.slice(0, 4);
  const details = useQueries({ queries: previewCourses.map(course => courseQueries.studentDetail(course.id)) });
  const now = Date.now();
  const assignments = details.flatMap((query, index) => {
    const detail = query.data as Detail | undefined;
    return (detail?.course.assignments ?? []).filter(assignment => assignment.due_date && Date.parse(assignment.due_date) >= now).map(assignment => ({ ...assignment, course: previewCourses[index] }));
  }).sort((a, b) => Date.parse(a.due_date!) - Date.parse(b.due_date!)).slice(0, 4);
  const announcements = details.flatMap((query, index) => {
    const detail = query.data as Detail | undefined;
    return (detail?.course.announcements ?? []).map(announcement => ({ ...announcement, course: previewCourses[index] }));
  }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 3);
  const loading = details.some(query => query.isPending);
  const detailError = details.some(query => query.isError);
  return <div className="work-dashboard"><div className="work-dashboard__hero"><div><h2>{courses.length ? 'Pick up where you left off' : 'Find your first course'}</h2><p>{courses.length ? 'Open a course for assignments, materials, and class updates.' : 'Browse the catalog and enroll to start learning.'}</p></div>{courses.length ? <Link className="work-dashboard__action" to={`/courses/${courses[0].id}`}>Open {courses[0].title}</Link> : <button type="button" className="work-dashboard__action" onClick={onBrowse}>Explore courses</button>}</div><div className="work-dashboard__grid"><Card><div className="work-dashboard__section-heading"><h2>Upcoming assignments</h2></div>{loading ? <Skeleton label="Loading assignments" lines={2} /> : assignments.length ? <ul className="work-dashboard__list">{assignments.map(item => <li key={`${item.course.id}-${item.id}`}><Link to={`/assignments/${item.id}`}>{item.title}</Link><span>{item.course.title} · Due {new Date(item.due_date!).toLocaleDateString()}</span></li>)}</ul> : <p className="work-dashboard__muted">No upcoming assignments in the previewed courses.</p>}</Card><Card><div className="work-dashboard__section-heading"><h2>Recent announcements</h2></div>{loading ? <Skeleton label="Loading announcements" lines={2} /> : announcements.length ? <ul className="work-dashboard__list">{announcements.map(item => <li key={`${item.course.id}-${item.id}`}><Link to={`/courses/${item.course.id}`}>{item.title}</Link><span>{item.course.title} · {new Date(item.created_at).toLocaleDateString()}</span></li>)}</ul> : <p className="work-dashboard__muted">No recent announcements in the previewed courses.</p>}</Card></div>{courses.length > 4 && <p className="work-dashboard__muted">Previewing your four most recently enrolled courses. Open a course to see its full activity.</p>}{detailError && <InlineAlert tone="warning" title="Some course updates are unavailable">Open a course to retry its assignments and announcements.</InlineAlert>}<section className="work-dashboard__courses"><div className="work-dashboard__section-heading"><h2>Recently enrolled courses</h2><button type="button" onClick={onViewAll}>View all enrolled courses</button></div>{courses.length ? <div className="work-dashboard__course-grid">{courses.slice(0, 6).map(course => <Card key={course.id}><h3>{course.title}</h3><p>{course.instructor_name || 'Instructor to be assigned'}</p><Link to={`/courses/${course.id}`}>View course</Link></Card>)}</div> : <p className="work-dashboard__muted">You are not enrolled in a course yet.</p>}</section></div>;
}
