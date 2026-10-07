import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { studentAPI } from '../services/api';
import { Button, Card, InlineAlert, Skeleton } from '../components/ui';
import { StudentOverview } from '../features/dashboard/StudentOverview';
import type { StudentCourse } from '../features/dashboard/StudentOverview';
import './StudentDashboard.css';

type View = 'overview' | 'my-courses' | 'all-courses';

function CourseList({ courses, enrolled, onEnroll, onUnenroll, busy }: { courses: StudentCourse[]; enrolled: boolean; onEnroll: (id: number) => void; onUnenroll: (id: number) => void; busy: boolean }) {
  if (!courses.length) return <p className="work-dashboard__muted">{enrolled ? 'You are not enrolled in a course yet.' : 'No courses are available right now.'}</p>;
  return <div className="work-dashboard__course-grid">{courses.map(course => <Card key={course.id}><h3>{course.title}</h3><p>{course.description}</p><p>Instructor: {course.instructor_name || 'To be assigned'}</p><div className="student-course-actions">{(enrolled || course.is_enrolled) ? <><Link to={`/courses/${course.id}`}>Open course</Link><Button variant="ghost" size="sm" disabled={busy} onClick={() => onUnenroll(course.id)}>Unenroll</Button></> : <Button size="sm" disabled={busy} onClick={() => onEnroll(course.id)}>Enroll</Button>}</div></Card>)}</div>;
}

export default function StudentDashboard() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get('view');
  const view: View = requestedView === 'my-courses' || requestedView === 'all-courses' ? requestedView : 'overview';
  const setView = (next: View) => setSearchParams(next === 'overview' ? {} : { view: next });
  const myCourses = useInfiniteQuery({ queryKey: ['student', 'my-courses'], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam, signal }) => studentAPI.getMyCourses({ limit: 20, cursor: pageParam }, signal).then(response => response.data as { courses: StudentCourse[]; page?: { nextCursor?: string | null; hasMore?: boolean } }), getNextPageParam: last => last.page?.hasMore ? last.page.nextCursor ?? undefined : undefined, staleTime: 60_000 });
  const allCourses = useInfiniteQuery({ queryKey: ['student', 'catalog'], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam, signal }) => studentAPI.getCourses(signal, { limit: 20, cursor: pageParam }).then(response => response.data as { courses: StudentCourse[]; page?: { nextCursor?: string | null; hasMore?: boolean } }), getNextPageParam: last => last.page?.hasMore ? last.page.nextCursor ?? undefined : undefined, enabled: view === 'all-courses', staleTime: 60_000 });
  const enrolledCourses = myCourses.data?.pages.flatMap(page => page.courses) ?? [];
  const catalogCourses = allCourses.data?.pages.flatMap(page => page.courses) ?? [];
  const membership = useMutation({ mutationFn: ({ id, enroll }: { id: number; enroll: boolean }) => enroll ? studentAPI.enrollInCourse(id) : studentAPI.unenrollFromCourse(id), onSuccess: (_response, variables) => { void client.invalidateQueries({ queryKey: ['student', 'my-courses'] }); void client.invalidateQueries({ queryKey: ['student', 'catalog'] }); void client.invalidateQueries({ queryKey: ['courses'] }); showToast(variables.enroll ? 'Enrolled in course' : 'Unenrolled from course', 'success'); }, onError: (error: unknown) => { showToast(error instanceof Error ? error.message : 'Could not update enrollment', 'error'); } });
  function unenroll(id: number) { if (window.confirm('Unenroll from this course?')) membership.mutate({ id, enroll: false }); }
  return <div className="student-dashboard student-dashboard--workspace"><header className="student-workspace-header"><div><h1>Learning workspace</h1><p>Welcome, {user?.fullName}. Choose what to work on next.</p></div><Link className="student-workspace-tutor" to="/ai-agent-hub">Open AI tutor</Link></header><nav aria-label="Student dashboard views" className="student-workspace-tabs"><button type="button" aria-current={view === 'overview' ? 'page' : undefined} onClick={() => setView('overview')}>Overview</button><button type="button" aria-current={view === 'my-courses' ? 'page' : undefined} onClick={() => setView('my-courses')}>My courses</button><button type="button" aria-current={view === 'all-courses' ? 'page' : undefined} onClick={() => setView('all-courses')}>Explore courses</button></nav><div className="student-workspace-content">{view === 'overview' && (myCourses.isPending ? <Skeleton label="Loading your courses" /> : myCourses.isError ? <InlineAlert tone="danger" title="Your courses could not be loaded"><Button variant="secondary" size="sm" onClick={() => void myCourses.refetch()}>Retry</Button></InlineAlert> : <StudentOverview courses={enrolledCourses} onBrowse={() => setView('all-courses')} onViewAll={() => setView('my-courses')} />)}{view === 'my-courses' && <section><h2>My courses</h2>{myCourses.isPending ? <Skeleton label="Loading your courses" /> : myCourses.isError ? <InlineAlert tone="danger">Could not load your courses. <Button variant="secondary" size="sm" onClick={() => void myCourses.refetch()}>Retry</Button></InlineAlert> : <><CourseList courses={enrolledCourses} enrolled onEnroll={id => membership.mutate({ id, enroll: true })} onUnenroll={unenroll} busy={membership.isPending} />{myCourses.hasNextPage && <Button variant="secondary" onClick={() => void myCourses.fetchNextPage()} loading={myCourses.isFetchingNextPage}>Load more enrolled courses</Button>}</>}</section>}{view === 'all-courses' && <section><h2>Explore courses</h2>{allCourses.isPending ? <Skeleton label="Loading available courses" /> : allCourses.isError ? <InlineAlert tone="danger">Could not load available courses. <Button variant="secondary" size="sm" onClick={() => void allCourses.refetch()}>Retry</Button></InlineAlert> : <><CourseList courses={catalogCourses} enrolled={false} onEnroll={id => membership.mutate({ id, enroll: true })} onUnenroll={unenroll} busy={membership.isPending} />{allCourses.hasNextPage && <Button variant="secondary" onClick={() => void allCourses.fetchNextPage()} loading={allCourses.isFetchingNextPage}>Load more courses</Button>}</>}</section>}</div></div>;
}
