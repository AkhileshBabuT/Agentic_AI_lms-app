import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { rootAPI, usageAPI } from '../services/api';
import MaterialIndexStatus from '../components/MaterialIndexStatus';
import './RootDashboard.css';

interface PendingProfessor {
  id: number;
  full_name: string;
  email: string;
  status: string;
  created_at: string;
  course_id: number;
  course_title: string;
}

interface User {
  id: number;
  full_name: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
}

interface Professor {
  id: number;
  full_name: string;
  email: string;
  status: string;
  created_at: string;
  assigned_courses: Array<{
    course_id: number;
    course_title: string;
    assigned_at: string;
  }> | null;
}

interface Course {
  id: number;
  title: string;
  description: string;
  instructor_name: string;
  instructor_email: string;
  enrolled_students: number;
}

interface Stats {
  users: { [role: string]: number };
  totalCourses: number;
  totalEnrollments: number;
  pendingProfessors: number;
}

const RootDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'overview' | 'pending' | 'professors' | 'users' | 'courses' | 'files' | 'usage'>('overview');
  const [loading, setLoading] = useState(false);

  // State
  const [stats, setStats] = useState<Stats | null>(null);
  const [pendingProfessors, setPendingProfessors] = useState<PendingProfessor[]>([]);
  const [professors, setProfessors] = useState<Professor[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [fileStats, setFileStats] = useState<any>(null);
  const [usageSummary, setUsageSummary] = useState<any[]>([]);
  const [usageStats, setUsageStats] = useState<any>(null);
  const [usageLogs, setUsageLogs] = useState<any[]>([]);
  const [usageFilter, setUsageFilter] = useState<string>('');
  const [usageView, setUsageView] = useState<'summary' | 'logs'>('summary');

  // New course form
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [newCourse, setNewCourse] = useState({ title: '', description: '' });

  // Course assignment
  const [showAssignCourse, setShowAssignCourse] = useState(false);
  const [selectedProfessor, setSelectedProfessor] = useState<Professor | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');

  useEffect(() => {
    if (activeTab === 'overview') loadStats();
    if (activeTab === 'pending') loadPendingProfessors();
    if (activeTab === 'professors') loadProfessors();
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'courses') loadCourses();
    if (activeTab === 'files') loadFiles();
    if (activeTab === 'usage') loadUsage();
  }, [activeTab]);

  const loadStats = async () => {
    try {
      setLoading(true);
      const response = await rootAPI.getStats();
      setStats(response.data.stats);
    } catch (error) {
      showToast('Failed to load statistics', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadPendingProfessors = async () => {
    try {
      setLoading(true);
      const response = await rootAPI.getPendingProfessors();
      setPendingProfessors(response.data.professors);
    } catch (error) {
      showToast('Failed to load pending professors', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      setLoading(true);
      const response = await rootAPI.getUsers();
      setUsers(response.data.users);
    } catch (error) {
      showToast('Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadCourses = async () => {
    try {
      setLoading(true);
      const response = await rootAPI.getCourses();
      setCourses(response.data.courses);
    } catch (error) {
      showToast('Failed to load courses', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleApproveProfessor = async (professorId: number, status: 'approved' | 'rejected') => {
    if (!confirm(`Are you sure you want to ${status === 'approved' ? 'approve' : 'reject'} this professor?`)) {
      return;
    }

    try {
      await rootAPI.updateProfessorStatus(professorId, status);
      showToast(`Professor ${status} successfully`, 'success');
      loadPendingProfessors();
      loadStats(); // Always refresh stats to update the badge count
    } catch (error: any) {
      showToast(error.response?.data?.error || `Failed to ${status} professor`, 'error');
    }
  };

  const handleDeleteUser = async (userId: number) => {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
      return;
    }

    try {
      await rootAPI.deleteUser(userId);
      showToast('User deleted successfully', 'success');
      loadUsers();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete user', 'error');
    }
  };

  const handleAddCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await rootAPI.createCourse(newCourse);
      showToast('Course created successfully', 'success');
      setNewCourse({ title: '', description: '' });
      setShowAddCourse(false);
      loadCourses();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to create course', 'error');
    }
  };

  const handleDeleteCourse = async (courseId: number) => {
    if (!confirm('Are you sure you want to delete this course? This will also remove all enrollments and assignments.')) {
      return;
    }

    try {
      await rootAPI.deleteCourse(courseId);
      showToast('Course deleted successfully', 'success');
      loadCourses();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete course', 'error');
    }
  };

  const loadProfessors = async () => {
    try {
      setLoading(true);
      const response = await rootAPI.getProfessors();
      setProfessors(response.data.professors);
    } catch (error) {
      showToast('Failed to load professors', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAssignCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProfessor || !selectedCourseId) return;

    try {
      await rootAPI.assignCourse(selectedProfessor.id, parseInt(selectedCourseId));
      showToast('Course assigned successfully', 'success');
      setShowAssignCourse(false);
      setSelectedProfessor(null);
      setSelectedCourseId('');
      loadProfessors();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to assign course', 'error');
    }
  };

  const handleRemoveCourse = async (professorId: number, courseId: number) => {
    if (!confirm('Are you sure you want to remove this course from the professor?')) {
      return;
    }

    try {
      await rootAPI.removeCourse(professorId, courseId);
      showToast('Course removed successfully', 'success');
      loadProfessors();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to remove course', 'error');
    }
  };

  const handleDeleteProfessor = async (professorId: number) => {
    if (!confirm('Are you sure you want to delete this professor? This action cannot be undone.')) {
      return;
    }

    try {
      await rootAPI.deleteProfessor(professorId);
      showToast('Professor deleted successfully', 'success');
      loadProfessors();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete professor', 'error');
    }
  };

  const openAssignCourseModal = async (professor: Professor) => {
    setSelectedProfessor(professor);
    setSelectedCourseId('');
    setShowAssignCourse(true);
    // Load courses if not already loaded
    if (courses.length === 0) {
      try {
        const response = await rootAPI.getCourses();
        setCourses(response.data.courses);
      } catch (error) {
        showToast('Failed to load courses', 'error');
      }
    }
  };

  const loadFiles = async () => {
    try {
      setLoading(true);
      const [materialsRes, submissionsRes, statsRes] = await Promise.all([
        rootAPI.getAllMaterials(),
        rootAPI.getAllSubmissions(),
        rootAPI.getFileStats()
      ]);

      setMaterials(materialsRes.data.materials || []);
      setSubmissions(submissionsRes.data.submissions || []);
      setFileStats(statsRes.data.stats);
    } catch (error) {
      showToast('Failed to load file data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadUsage = async () => {
    try {
      setLoading(true);
      const params = usageFilter ? { actionType: usageFilter } : undefined;
      const [summaryRes, statsRes, logsRes] = await Promise.all([
        usageAPI.getSummary(params),
        usageAPI.getStats(),
        usageAPI.getLogs({ ...params, limit: 50 }),
      ]);
      setUsageSummary(summaryRes.data.summary || []);
      setUsageStats(statsRes.data.stats || null);
      setUsageLogs(logsRes.data.logs || []);
    } catch (error) {
      showToast('Failed to load usage data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const handleDownloadFile = async (type: 'material' | 'submission' | 'assignment', fileId: number) => {
    try {
      const response = await rootAPI.downloadFile(type, fileId);
      window.open(response.data.url, '_blank');
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to download file', 'error');
    }
  };

  return (
    <div className="root-dashboard">
      <header className="dashboard-header">
        <div className="header-content">
          <div>
            <h1>Root Dashboard</h1>
            <p>Welcome, {user?.fullName}</p>
          </div>
          <div className="header-actions">
            <button onClick={() => navigate('/ai-agent-hub')} className="ai-hub-button">
              🤖 AI Agent Hub
            </button>
            <button onClick={logout} className="logout-button">
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="dashboard-tabs">
        <button
          className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`tab ${activeTab === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          Pending Professors
          {stats && stats.pendingProfessors > 0 && (
            <span className="badge">{stats.pendingProfessors}</span>
          )}
        </button>
        <button
          className={`tab ${activeTab === 'professors' ? 'active' : ''}`}
          onClick={() => setActiveTab('professors')}
        >
          Manage Professors
        </button>
        <button
          className={`tab ${activeTab === 'users' ? 'active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          Users
        </button>
        <button
          className={`tab ${activeTab === 'courses' ? 'active' : ''}`}
          onClick={() => setActiveTab('courses')}
        >
          Courses
        </button>
        <button
          className={`tab ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          Files
        </button>
        <button
          className={`tab ${activeTab === 'usage' ? 'active' : ''}`}
          onClick={() => setActiveTab('usage')}
        >
          Usage Logs
        </button>
      </div>

      <main className="dashboard-main">
        {loading && <div className="loading">Loading...</div>}

        {/* Overview Tab */}
        {activeTab === 'overview' && stats && (
          <div className="overview-section">
            <h2>System Statistics</h2>
            <div className="stats-grid">
              <div className="stat-card">
                <h3>{stats.users.student || 0}</h3>
                <p>Students</p>
              </div>
              <div className="stat-card">
                <h3>{stats.users.professor || 0}</h3>
                <p>Professors</p>
              </div>
              <div className="stat-card">
                <h3>{stats.totalCourses}</h3>
                <p>Total Courses</p>
              </div>
              <div className="stat-card">
                <h3>{stats.totalEnrollments}</h3>
                <p>Total Enrollments</p>
              </div>
              <div className="stat-card highlight">
                <h3>{stats.pendingProfessors}</h3>
                <p>Pending Approvals</p>
              </div>
            </div>

            <div className="settings-card">
              <h3>Course answer sources</h3>
              <p>
                Course answers use authorized, indexed course materials and include supporting document references.
                Questions without enough document evidence receive an explanation of what is missing.
              </p>
            </div>
          </div>
        )}

        {/* Pending Professors Tab */}
        {activeTab === 'pending' && (
          <div className="professors-section">
            <h2>Pending Professor Approvals</h2>
            {pendingProfessors.length === 0 ? (
              <p className="empty-message">No pending professor approvals</p>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Applied On</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingProfessors.map((prof) => (
                      <tr key={prof.id}>
                        <td>{prof.full_name}</td>
                        <td>{prof.email}</td>
                        <td>{new Date(prof.created_at).toLocaleDateString()}</td>
                        <td>
                          <div className="action-buttons">
                            <button
                              className="btn-approve"
                              onClick={() => handleApproveProfessor(prof.id, 'approved')}
                            >
                              Approve
                            </button>
                            <button
                              className="btn-reject"
                              onClick={() => handleApproveProfessor(prof.id, 'rejected')}
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Manage Professors Tab */}
        {activeTab === 'professors' && (
          <div className="professors-section">
            <h2>Manage Professors</h2>
            {professors.length === 0 ? (
              <p className="empty-message">No professors found</p>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Status</th>
                      <th>Assigned Courses</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {professors.map((prof) => (
                      <tr key={prof.id}>
                        <td>{prof.full_name}</td>
                        <td>{prof.email}</td>
                        <td>
                          <span className={`status-badge ${prof.status}`}>
                            {prof.status}
                          </span>
                        </td>
                        <td>
                          {prof.assigned_courses && prof.assigned_courses.length > 0 ? (
                            <div className="assigned-courses">
                              {prof.assigned_courses.map((course) => (
                                <div key={course.course_id} className="course-tag">
                                  {course.course_title}
                                  <button
                                    className="remove-course-btn"
                                    onClick={() => handleRemoveCourse(prof.id, course.course_id)}
                                    title="Remove course"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted">No courses assigned</span>
                          )}
                        </td>
                        <td>
                          <div className="action-buttons">
                            <button
                              className="btn-primary"
                              onClick={() => openAssignCourseModal(prof)}
                              disabled={prof.status === 'pending' || prof.status === 'rejected'}
                            >
                              Assign Course
                            </button>
                            <button
                              className="btn-delete"
                              onClick={() => handleDeleteProfessor(prof.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {showAssignCourse && selectedProfessor && (
              <div className="modal-overlay" onClick={() => setShowAssignCourse(false)}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h3>Assign Course to {selectedProfessor.full_name}</h3>
                  <form onSubmit={handleAssignCourse}>
                    <div className="form-group">
                      <label>Select Course</label>
                      <select
                        value={selectedCourseId}
                        onChange={(e) => setSelectedCourseId(e.target.value)}
                        required
                      >
                        <option value="">Choose a course...</option>
                        {courses
                          .filter(c => !c.instructor_name) // Only show unassigned courses
                          .map((course) => (
                            <option key={course.id} value={course.id}>
                              {course.title}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="modal-actions">
                      <button type="button" onClick={() => setShowAssignCourse(false)} className="btn-secondary">
                        Cancel
                      </button>
                      <button type="submit" className="btn-primary">
                        Assign Course
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Users Tab */}
        {activeTab === 'users' && (
          <div className="users-section">
            <h2>All Users</h2>
            {users.length === 0 ? (
              <p className="empty-message">No users found</p>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Joined</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>{user.full_name}</td>
                        <td>{user.email}</td>
                        <td>
                          <span className={`role-badge ${user.role}`}>
                            {user.role}
                          </span>
                        </td>
                        <td>
                          <span className={`status-badge ${user.status}`}>
                            {user.status}
                          </span>
                        </td>
                        <td>{new Date(user.created_at).toLocaleDateString()}</td>
                        <td>
                          {user.role !== 'root' && (
                            <button
                              className="btn-delete"
                              onClick={() => handleDeleteUser(user.id)}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Courses Tab */}
        {activeTab === 'courses' && (
          <div className="courses-section">
            <div className="section-header">
              <h2>All Courses</h2>
              <button
                className="btn-primary"
                onClick={() => setShowAddCourse(true)}
              >
                + Add Course
              </button>
            </div>

            {showAddCourse && (
              <div className="modal-overlay" onClick={() => setShowAddCourse(false)}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h3>Create New Course</h3>
                  <form onSubmit={handleAddCourse}>
                    <div className="form-group">
                      <label>Course Title</label>
                      <input
                        type="text"
                        value={newCourse.title}
                        onChange={(e) => setNewCourse({ ...newCourse, title: e.target.value })}
                        required
                        placeholder="e.g., Introduction to Computer Science"
                      />
                    </div>
                    <div className="form-group">
                      <label>Description</label>
                      <textarea
                        value={newCourse.description}
                        onChange={(e) => setNewCourse({ ...newCourse, description: e.target.value })}
                        placeholder="Course description..."
                        rows={4}
                      />
                    </div>
                    <div className="modal-actions">
                      <button type="button" onClick={() => setShowAddCourse(false)} className="btn-secondary">
                        Cancel
                      </button>
                      <button type="submit" className="btn-primary">
                        Create Course
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {courses.length === 0 ? (
              <p className="empty-message">No courses found</p>
            ) : (
              <div className="courses-grid">
                {courses.map((course) => (
                  <div key={course.id} className="course-card">
                    <div className="course-header">
                      <h3>{course.title}</h3>
                      <button
                        className="btn-delete-icon"
                        onClick={() => handleDeleteCourse(course.id)}
                        title="Delete course"
                      >
                        ✕
                      </button>
                    </div>
                    <p className="course-description">{course.description}</p>
                    <div className="course-info">
                      <p><strong>Instructor:</strong> {course.instructor_name || 'Not assigned'}</p>
                      <p><strong>Students:</strong> {course.enrolled_students}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Files Tab */}
        {activeTab === 'files' && (
          <div className="files-section">
            <h2>File Management & Monitoring</h2>

            {fileStats && (
              <div className="stats-grid">
                <div className="stat-card">
                  <h3>{fileStats.courseMaterials.count}</h3>
                  <p>Course Materials</p>
                  <small>{formatFileSize(fileStats.courseMaterials.totalSize)}</small>
                </div>
                <div className="stat-card">
                  <h3>{fileStats.submissions.count}</h3>
                  <p>Submissions</p>
                </div>
                <div className="stat-card">
                  <h3>{fileStats.submissionFiles.count}</h3>
                  <p>Submission Files</p>
                  <small>{formatFileSize(fileStats.submissionFiles.totalSize)}</small>
                </div>
                <div className="stat-card highlight">
                  <h3>{formatFileSize(fileStats.courseMaterials.totalSize + fileStats.submissionFiles.totalSize)}</h3>
                  <p>Total Storage Used</p>
                </div>
              </div>
            )}

            <div className="files-subsection">
              <h3>Course Materials</h3>
              {materials.length === 0 ? (
                <p className="empty-message">No course materials uploaded yet</p>
              ) : (
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>File Name</th>
                        <th>Course</th>
                        <th>Uploaded By</th>
                        <th>Size</th>
                        <th>Date</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {materials.map((material) => (
                        <tr key={material.id}>
                          <td>{material.file_name}<MaterialIndexStatus material={material} showError /></td>
                          <td>{material.course_title}</td>
                          <td>{material.uploader_name}</td>
                          <td>{formatFileSize(material.file_size)}</td>
                          <td>{new Date(material.uploaded_at).toLocaleDateString()}</td>
                          <td>
                            <button
                              className="btn-secondary btn-sm"
                              onClick={() => handleDownloadFile('material', material.id)}
                            >
                              Download
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="files-subsection">
              <h3>Assignment Submissions</h3>
              {submissions.length === 0 ? (
                <p className="empty-message">No submissions yet</p>
              ) : (
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Assignment</th>
                        <th>Course</th>
                        <th>Files</th>
                        <th>Grade</th>
                        <th>Submitted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {submissions.map((submission) => (
                        <tr key={submission.id}>
                          <td>{submission.student_name}</td>
                          <td>{submission.assignment_title}</td>
                          <td>{submission.course_title}</td>
                          <td>
                            {submission.files && submission.files.length > 0 ? (
                              <span className="file-count">
                                {submission.files.length} file(s)
                              </span>
                            ) : (
                              <span className="text-muted">No files</span>
                            )}
                          </td>
                          <td>
                            {submission.grade !== null ? (
                              <span className="grade-badge">{submission.grade}</span>
                            ) : (
                              <span className="text-muted">Not graded</span>
                            )}
                          </td>
                          <td>{new Date(submission.submitted_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Usage Logs Tab */}
        {activeTab === 'usage' && (
          <div className="usage-section">
            <div className="section-header">
              <h2>API Usage Logs</h2>
              <div className="usage-controls">
                <select
                  value={usageFilter}
                  onChange={(e) => {
                    setUsageFilter(e.target.value);
                    // Reload with new filter after state update
                    setTimeout(() => loadUsage(), 0);
                  }}
                  className="usage-filter-select"
                  title="Filter by action type"
                >
                  <option value="">All Actions</option>
                  <option value="file_upload">File Uploads</option>
                  <option value="llm_request">LLM Requests</option>
                  <option value="grading_request">Grading Requests</option>
                  <option value="file_download">File Downloads</option>
                </select>
                <div className="usage-view-toggle">
                  <button
                    type="button"
                    className={`toggle-btn ${usageView === 'summary' ? 'active' : ''}`}
                    onClick={() => setUsageView('summary')}
                  >
                    Per User
                  </button>
                  <button
                    type="button"
                    className={`toggle-btn ${usageView === 'logs' ? 'active' : ''}`}
                    onClick={() => setUsageView('logs')}
                  >
                    Detailed Logs
                  </button>
                </div>
              </div>
            </div>

            {usageStats && (
              <div className="stats-grid">
                <div className="stat-card">
                  <h3>{usageStats.total_file_uploads}</h3>
                  <p>File Uploads</p>
                </div>
                <div className="stat-card">
                  <h3>{usageStats.total_llm_requests}</h3>
                  <p>LLM Requests</p>
                </div>
                <div className="stat-card">
                  <h3>{usageStats.total_grading_requests}</h3>
                  <p>Grading Requests</p>
                </div>
                <div className="stat-card highlight">
                  <h3>{usageStats.total_actions}</h3>
                  <p>Total Actions</p>
                </div>
                <div className="stat-card">
                  <h3>{usageStats.unique_users}</h3>
                  <p>Active Users</p>
                </div>
              </div>
            )}

            {/* Per-User Summary View */}
            {usageView === 'summary' && (
              <div className="files-subsection">
                <h3>Usage Per User</h3>
                {usageSummary.length === 0 ? (
                  <p className="empty-message">No usage data yet</p>
                ) : (
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Role</th>
                          <th>File Uploads</th>
                          <th>LLM Requests</th>
                          <th>Grading</th>
                          <th>Total</th>
                          <th>Last Active</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usageSummary.map((row: any) => (
                          <tr key={row.user_id}>
                            <td>
                              <div>{row.full_name}</div>
                              <small className="text-muted">{row.email}</small>
                            </td>
                            <td>
                              <span className={`role-badge ${row.role}`}>{row.role}</span>
                            </td>
                            <td>{row.file_uploads}</td>
                            <td>{row.llm_requests}</td>
                            <td>{row.grading_requests}</td>
                            <td><strong>{row.total_actions}</strong></td>
                            <td>{row.last_activity ? new Date(row.last_activity).toLocaleDateString() : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Detailed Logs View */}
            {usageView === 'logs' && (
              <div className="files-subsection">
                <h3>Recent Activity</h3>
                {usageLogs.length === 0 ? (
                  <p className="empty-message">No logs found</p>
                ) : (
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>User</th>
                          <th>Action</th>
                          <th>Endpoint</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usageLogs.map((log: any) => (
                          <tr key={log.id}>
                            <td>{new Date(log.created_at).toLocaleString()}</td>
                            <td>
                              <div>{log.full_name}</div>
                              <small className="text-muted">{log.role}</small>
                            </td>
                            <td>
                              <span className={`action-badge ${log.action_type}`}>
                                {log.action_type.replace('_', ' ')}
                              </span>
                            </td>
                            <td><code className="endpoint-code">{log.endpoint}</code></td>
                            <td>
                              {log.metadata?.fileName && <span>{log.metadata.fileName}</span>}
                              {log.metadata?.responseLength && <span>Response: {log.metadata.responseLength} chars</span>}
                              {log.action_type !== 'llm_request' && log.metadata?.confidence !== undefined && <span>Confidence: {(log.metadata.confidence * 100).toFixed(0)}%</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default RootDashboard;
