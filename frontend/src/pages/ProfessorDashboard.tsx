import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { professorAPI } from '../services/api';
import { validateByType } from '../utils/fileValidation';
import MaterialIndexStatus from '../components/MaterialIndexStatus';
import './ProfessorDashboard.css';

const ProfessorDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'overview' | 'students' | 'materials' | 'assignments' | 'announcements'>('overview');
  const [loading, setLoading] = useState(false);

  const [course, setCourse] = useState<any>(null);
  const [students, setStudents] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [announcements, setAnnouncements] = useState<any[]>([]);

  const [showAddAssignment, setShowAddAssignment] = useState(false);
  const [showAddAnnouncement, setShowAddAnnouncement] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [newAssignment, setNewAssignment] = useState({ title: '', description: '', questionText: '', dueDate: '', points: 100 });
  const [newAnnouncement, setNewAnnouncement] = useState({ title: '', content: '' });

  // Folder navigation state
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [folders, setFolders] = useState<any[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<any[]>([]);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [retryingMaterialId, setRetryingMaterialId] = useState<number | null>(null);

  useEffect(() => {
    loadCourse();
  }, []);

  useEffect(() => {
    if (activeTab === 'students') loadStudents();
    if (activeTab === 'assignments') loadAssignments();
    if (activeTab === 'announcements') loadAnnouncements();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'materials') loadMaterials();
  }, [activeTab, currentFolderId]);

  const loadCourse = async () => {
    try {
      const response = await professorAPI.getCourse();
      setCourse(response.data.course);
    } catch (error) {
      showToast('Failed to load course', 'error');
    }
  };

  const loadStudents = async () => {
    try {
      setLoading(true);
      const response = await professorAPI.getStudents();
      setStudents(response.data.students);
    } catch (error) {
      showToast('Failed to load students', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadAssignments = async () => {
    try {
      setLoading(true);
      const response = await professorAPI.getAssignments();
      setAssignments(response.data.assignments);
    } catch (error) {
      showToast('Failed to load assignments', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadMaterials = async () => {
    try {
      setLoading(true);
      const [materialsRes, foldersRes] = await Promise.all([
        professorAPI.getMaterials(currentFolderId === null ? null : currentFolderId),
        professorAPI.getFolders(currentFolderId),
      ]);
      setMaterials(materialsRes.data.materials);
      setFolders(foldersRes.data.folders);

      if (currentFolderId !== null) {
        const breadcrumbRes = await professorAPI.getFolderBreadcrumb(currentFolderId);
        setBreadcrumb(breadcrumbRes.data.breadcrumb);
      } else {
        setBreadcrumb([]);
      }
    } catch (error) {
      showToast('Failed to load course materials', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadAnnouncements = async () => {
    try {
      setLoading(true);
      const response = await professorAPI.getAnnouncements();
      setAnnouncements(response.data.announcements);
    } catch (error) {
      showToast('Failed to load announcements', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAddAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await professorAPI.createAssignment(newAssignment);
      showToast('Assignment created successfully', 'success');
      setNewAssignment({ title: '', description: '', questionText: '', dueDate: '', points: 100 });
      setShowAddAssignment(false);
      loadAssignments();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to create assignment', 'error');
    }
  };

  const handleDeleteAssignment = async (id: number) => {
    if (!confirm('Are you sure you want to delete this assignment?')) return;
    try {
      await professorAPI.deleteAssignment(id);
      showToast('Assignment deleted successfully', 'success');
      loadAssignments();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete assignment', 'error');
    }
  };

  const handleAddAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await professorAPI.createAnnouncement(newAnnouncement);
      showToast('Announcement posted successfully', 'success');
      setNewAnnouncement({ title: '', content: '' });
      setShowAddAnnouncement(false);
      loadAnnouncements();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to post announcement', 'error');
    }
  };

  const handleDeleteAnnouncement = async (id: number) => {
    if (!confirm('Are you sure you want to delete this announcement?')) return;
    try {
      await professorAPI.deleteAnnouncement(id);
      showToast('Announcement deleted successfully', 'success');
      loadAnnouncements();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete announcement', 'error');
    }
  };

  const handleUploadMaterials = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Client-side validation
    const validation = validateByType(files, 'courseMaterials');
    if (!validation.valid) {
      showToast(validation.error || 'Invalid file selection', 'error');
      e.target.value = '';
      return;
    }

    try {
      setUploadingFiles(true);
      await professorAPI.uploadMaterials(files, currentFolderId);
      showToast(`${files.length} attachment(s) accepted. Indexing will run in the background.`, 'success');
      loadMaterials();
      e.target.value = '';
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to upload materials', 'error');
      e.target.value = '';
    } finally {
      setUploadingFiles(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      setCreatingFolder(true);
      await professorAPI.createFolder({
        name: newFolderName.trim(),
        parentId: currentFolderId,
      });
      showToast('Folder created successfully', 'success');
      setNewFolderName('');
      setShowCreateFolder(false);
      loadMaterials();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to create folder', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (folderId: number) => {
    if (!confirm('Are you sure? This will delete the folder and ALL its contents (subfolders and files).')) return;
    try {
      await professorAPI.deleteFolder(folderId);
      showToast('Folder deleted successfully', 'success');
      loadMaterials();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete folder', 'error');
    }
  };

  const handleDeleteMaterial = async (id: number) => {
    if (!confirm('Are you sure you want to delete this material?')) return;
    try {
      await professorAPI.deleteMaterial(id);
      showToast('Material deleted successfully', 'success');
      loadMaterials();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to delete material', 'error');
    }
  };

  const handleDownloadMaterial = async (id: number) => {
    try {
      const response = await professorAPI.downloadMaterial(id);
      window.open(response.data.url, '_blank');
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Failed to download material', 'error');
    }
  };

  const handleReindexMaterial = async (id: number) => {
    try {
      setRetryingMaterialId(id);
      await professorAPI.reindexMaterial(id);
      showToast('Attachment queued for indexing. Refresh to check its status.', 'success');
      await loadMaterials();
    } catch (error: any) {
      showToast(error.response?.data?.error || 'Could not queue attachment for indexing', 'error');
    } finally { setRetryingMaterialId(null); }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  // Check if professor is pending
  if (user?.status === 'pending') {
    return (
      <div className="pending-approval">
        <div className="pending-card">
          <h1>Account Pending Approval</h1>
          <p>Your professor account is currently under review by an administrator.</p>
          <p>You will receive access to your dashboard once your account is approved.</p>
          <button onClick={logout} className="logout-button">Logout</button>
        </div>
      </div>
    );
  }

  // Check if professor doesn't have a course assigned
  if (!course) {
    return (
      <div className="pending-approval">
        <div className="pending-card">
          <h1>No Course Assigned</h1>
          <p>You don't have any courses assigned yet.</p>
          <p>Please contact the administrator to get a course assigned to your account.</p>
          <button onClick={logout} className="logout-button">Logout</button>
        </div>
      </div>
    );
  }

  return (
    <div className="professor-dashboard">
      <header className="dashboard-header">
        <div className="header-content">
          <div>
            <h1>Professor Dashboard</h1>
            <p>Welcome, {user?.fullName}</p>
            {course && <p className="course-title">{course.title}</p>}
          </div>
          <div className="header-actions">
            <button onClick={() => navigate('/ai-agent-hub')} className="ai-hub-button">
              🤖 AI Agent Hub
            </button>
            <button onClick={logout} className="logout-button">Logout</button>
          </div>
        </div>
      </header>

      <div className="dashboard-tabs">
        <button className={`tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
          Overview
        </button>
        <button className={`tab ${activeTab === 'students' ? 'active' : ''}`} onClick={() => setActiveTab('students')}>
          Students
        </button>
        <button className={`tab ${activeTab === 'materials' ? 'active' : ''}`} onClick={() => setActiveTab('materials')}>
          Course Materials
        </button>
        <button className={`tab ${activeTab === 'assignments' ? 'active' : ''}`} onClick={() => setActiveTab('assignments')}>
          Assignments
        </button>
        <button className={`tab ${activeTab === 'announcements' ? 'active' : ''}`} onClick={() => setActiveTab('announcements')}>
          Announcements
        </button>
      </div>

      <main className="dashboard-main">
        {loading && <div className="loading">Loading...</div>}

        {activeTab === 'overview' && course && (
          <div className="overview-section">
            <div className="course-info-card">
              <h2>{course.title}</h2>
              <p>{course.description}</p>
              <div className="stats">
                <div className="stat">
                  <span className="stat-number">{course.enrolled_students_count}</span>
                  <span className="stat-label">Enrolled Students</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'students' && (
          <div className="students-section">
            <h2>Enrolled Students</h2>
            {students.length === 0 ? (
              <p className="empty-message">No students enrolled yet</p>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Enrolled On</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((student: any) => (
                      <tr key={student.id}>
                        <td>{student.full_name}</td>
                        <td>{student.email}</td>
                        <td>{new Date(student.enrolled_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'materials' && (
          <div className="materials-section">
            <div className="section-header">
              <h2>Course Materials</h2>
              <div className="materials-actions-bar">
                <button type="button" className="btn-secondary" onClick={loadMaterials} disabled={loading}>Refresh status</button>
                <button
                  className="btn-secondary"
                  onClick={() => setShowCreateFolder(true)}
                >
                  + New Folder
                </button>
                <label htmlFor="file-upload" className="btn-primary" style={{ cursor: 'pointer' }}>
                  {uploadingFiles ? 'Uploading...' : '+ Upload Files'}
                  <input
                    id="file-upload"
                    type="file"
                    multiple
                    onChange={handleUploadMaterials}
                    style={{ display: 'none' }}
                    disabled={uploadingFiles}
                  />
                </label>
              </div>
            </div>

            <p className="material-index-help">Attachments become available for course answers after indexing finishes. Scanned PDFs and images need a readable text version while text recognition is unavailable.</p>

            {/* Breadcrumb Navigation */}
            <div className="folder-breadcrumb">
              <button
                className={`breadcrumb-item ${currentFolderId === null ? 'active' : ''}`}
                onClick={() => setCurrentFolderId(null)}
              >
                🏠 Home
              </button>
              {breadcrumb.map((crumb: any, index: number) => (
                <React.Fragment key={crumb.id}>
                  <span className="breadcrumb-separator">/</span>
                  <button
                    className={`breadcrumb-item ${index === breadcrumb.length - 1 ? 'active' : ''}`}
                    onClick={() => setCurrentFolderId(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {/* Create Folder Modal */}
            {showCreateFolder && (
              <div className="modal-overlay" onClick={() => setShowCreateFolder(false)}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h3>Create New Folder</h3>
                  <div className="form-group">
                    <label>Folder Name</label>
                    <input
                      type="text"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Enter folder name..."
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreateFolder();
                      }}
                    />
                  </div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      onClick={() => { setShowCreateFolder(false); setNewFolderName(''); }}
                      className="btn-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateFolder}
                      className="btn-primary"
                      disabled={creatingFolder || !newFolderName.trim()}
                    >
                      {creatingFolder ? 'Creating...' : 'Create'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Folder & File List */}
            {folders.length === 0 && materials.length === 0 ? (
              <p className="empty-message">
                {currentFolderId === null
                  ? 'No course materials uploaded yet'
                  : 'This folder is empty'}
              </p>
            ) : (
              <div className="materials-list">
                {/* Folders first */}
                {folders.map((folder: any) => (
                  <div
                    key={`folder-${folder.id}`}
                    className="material-card folder-card"
                    onClick={() => setCurrentFolderId(folder.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="material-icon folder-icon">&#128193;</div>
                    <div className="material-info">
                      <h3>{folder.name}</h3>
                      <p className="material-meta">
                        Folder &bull; Created {new Date(folder.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="material-actions">
                      <button
                        className="btn-delete-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFolder(folder.id);
                        }}
                      >
                        &#10005;
                      </button>
                    </div>
                  </div>
                ))}

                {/* Files */}
                {materials.map((material: any) => (
                  <div key={`file-${material.id}`} className="material-card">
                    <div className="material-icon">&#128196;</div>
                    <div className="material-info">
                      <h3>{material.file_name}</h3>
                      <p className="material-meta">
                        {formatFileSize(material.file_size)} &bull;
                        Uploaded {new Date(material.uploaded_at).toLocaleDateString()}
                      </p>
                      <MaterialIndexStatus material={material} showError />
                    </div>
                    <div className="material-actions">
                      {['unindexed', 'failed', 'needs_review'].includes(material.ingestion_status || 'unindexed') && (
                        <button type="button" className="btn-secondary" onClick={() => handleReindexMaterial(material.id)} disabled={retryingMaterialId !== null}>
                          {retryingMaterialId === material.id ? 'Queuing...' : 'Retry indexing'}
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        onClick={() => handleDownloadMaterial(material.id)}
                      >
                        Download
                      </button>
                      <button
                        className="btn-delete-icon"
                        onClick={() => handleDeleteMaterial(material.id)}
                      >
                        &#10005;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'assignments' && (
          <div className="assignments-section">
            <div className="section-header">
              <h2>Assignments</h2>
              <button className="btn-primary" onClick={() => setShowAddAssignment(true)}>
                + Create Assignment
              </button>
            </div>

            {showAddAssignment && (
              <div className="modal-overlay" onClick={() => setShowAddAssignment(false)}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h3>Create Assignment</h3>
                  <form onSubmit={handleAddAssignment}>
                    <div className="form-group">
                      <label>Title</label>
                      <input
                        type="text"
                        value={newAssignment.title}
                        onChange={(e) => setNewAssignment({ ...newAssignment, title: e.target.value })}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Description</label>
                      <textarea
                        value={newAssignment.description}
                        onChange={(e) => setNewAssignment({ ...newAssignment, description: e.target.value })}
                        rows={3}
                      />
                    </div>
                    <div className="form-group">
                      <label>Question</label>
                      <textarea
                        value={newAssignment.questionText}
                        onChange={(e) => setNewAssignment({ ...newAssignment, questionText: e.target.value })}
                        placeholder="Enter the assignment question or instructions..."
                        rows={4}
                      />
                    </div>
                    <div className="form-group">
                      <label>Due Date</label>
                      <input
                        type="datetime-local"
                        value={newAssignment.dueDate}
                        onChange={(e) => setNewAssignment({ ...newAssignment, dueDate: e.target.value })}
                      />
                    </div>
                    <div className="form-group">
                      <label>Points</label>
                      <input
                        type="number"
                        value={newAssignment.points}
                        onChange={(e) => setNewAssignment({ ...newAssignment, points: parseInt(e.target.value) })}
                        min="0"
                      />
                    </div>
                    <div className="modal-actions">
                      <button type="button" onClick={() => setShowAddAssignment(false)} className="btn-secondary">
                        Cancel
                      </button>
                      <button type="submit" className="btn-primary">Create</button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {assignments.length === 0 ? (
              <p className="empty-message">No assignments created yet</p>
            ) : (
              <div className="assignments-list">
                {assignments.map((assignment: any) => (
                  <div
                    key={assignment.id}
                    className="assignment-card clickable"
                    onClick={() => navigate(`/professor/assignments/${assignment.id}`)}
                  >
                    <div className="assignment-header">
                      <h3>{assignment.title}</h3>
                      <button
                        className="btn-delete-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteAssignment(assignment.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    <p>{assignment.description}</p>
                    <div className="assignment-footer">
                      <span>Due: {assignment.due_date ? new Date(assignment.due_date).toLocaleDateString() : 'No due date'}</span>
                      <span>{assignment.points} points</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'announcements' && (
          <div className="announcements-section">
            <div className="section-header">
              <h2>Announcements</h2>
              <button className="btn-primary" onClick={() => setShowAddAnnouncement(true)}>
                + Post Announcement
              </button>
            </div>

            {showAddAnnouncement && (
              <div className="modal-overlay" onClick={() => setShowAddAnnouncement(false)}>
                <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <h3>Post Announcement</h3>
                  <form onSubmit={handleAddAnnouncement}>
                    <div className="form-group">
                      <label>Title</label>
                      <input
                        type="text"
                        value={newAnnouncement.title}
                        onChange={(e) => setNewAnnouncement({ ...newAnnouncement, title: e.target.value })}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Content</label>
                      <textarea
                        value={newAnnouncement.content}
                        onChange={(e) => setNewAnnouncement({ ...newAnnouncement, content: e.target.value })}
                        required
                        rows={6}
                      />
                    </div>
                    <div className="modal-actions">
                      <button type="button" onClick={() => setShowAddAnnouncement(false)} className="btn-secondary">
                        Cancel
                      </button>
                      <button type="submit" className="btn-primary">Post</button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {announcements.length === 0 ? (
              <p className="empty-message">No announcements posted yet</p>
            ) : (
              <div className="announcements-list">
                {announcements.map((announcement: any) => (
                  <div key={announcement.id} className="announcement-card">
                    <div className="announcement-header">
                      <h3>{announcement.title}</h3>
                      <button className="btn-delete-icon" onClick={() => handleDeleteAnnouncement(announcement.id)}>✕</button>
                    </div>
                    <p>{announcement.content}</p>
                    <div className="announcement-footer">
                      <span>Posted {new Date(announcement.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default ProfessorDashboard;
