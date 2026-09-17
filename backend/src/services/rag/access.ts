import { pool } from '../../config/database';
import { CourseIdentity, RagAccessError } from './types';

export interface Queryable { query: (sql: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> }

/** Re-read the account role and membership, rather than trusting a stale request role. */
export async function assertCourseAccess(identity: CourseIdentity, db: Queryable = pool, lock = false): Promise<void> {
  const user = await db.query(`SELECT role, status FROM users WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [identity.userId]);
  if (!user.rows.length || user.rows[0].role !== identity.role || ['pending', 'rejected'].includes(user.rows[0].status)) throw new RagAccessError();
  const course = await db.query(`SELECT instructor_id FROM courses WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [identity.courseId]);
  if (!course.rows.length) throw new RagAccessError();
  if (identity.role === 'root') return;
  if (identity.role === 'professor' && course.rows[0].instructor_id === identity.userId) return;
  const table = identity.role === 'student' ? 'enrollments' : identity.role === 'professor' ? 'course_instructors' : null;
  if (!table) throw new RagAccessError();
  const membership = await db.query(`SELECT id FROM ${table} WHERE course_id=$1 AND user_id=$2${lock ? ' FOR SHARE' : ''}`, [identity.courseId, identity.userId]);
  if (!membership.rows.length) throw new RagAccessError();
}

/** Same policy is embedded in both search branches and source resolution. */
export const COURSE_ACCESS_SQL = `EXISTS (
 SELECT 1 FROM users access_user JOIN courses access_course ON access_course.id=mc.course_id
 WHERE access_user.id=$2 AND access_user.role=$3
 AND COALESCE(access_user.status,'active') NOT IN ('pending','rejected')
 AND (access_user.role='root'
 OR (access_user.role='student' AND EXISTS(SELECT 1 FROM enrollments e WHERE e.course_id=mc.course_id AND e.user_id=$2))
 OR (access_user.role='professor' AND (access_course.instructor_id=$2 OR EXISTS(SELECT 1 FROM course_instructors ci WHERE ci.course_id=mc.course_id AND ci.user_id=$2))))
)`;
