import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { professorAPI } from '../services/api';
import { getAcceptAttribute, validateByType } from '../utils/fileValidation';
import MaterialIndexStatus from '../components/MaterialIndexStatus';
import type { MaterialIndexState } from '../types/rag';
import { ProfessorOverview } from '../features/dashboard/ProfessorOverview';
import './ProfessorDashboard.css';

interface ProfessorCourse { title: string; description?: string; enrolled_students_count: number }
interface EnrolledStudent { id: number; full_name: string; email: string; enrolled_at: string }
interface CourseMaterial extends MaterialIndexState { id: number; file_name: string; file_size: number; uploaded_at: string }
interface CourseAssignment { id: number; title: string; description: string; due_date: string | null; points: number }
interface CourseAnnouncement { id: number; title: string; content: string; created_at: string }
interface MaterialFolder { id: number; name: string; created_at: string }
interface FolderCrumb { id: number; name: string }

function apiErrorMessage(error: unknown, fallback: string): string {
  return axios.isAxiosError<{ error?: string }>(error) ? error.response?.data?.error || fallback : fallback;
}

const ProfessorDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  type ProfessorTab = 'overview' | 'students' | 'materials' | 'assignments' | 'announcements';
  const requestedTab = searchParams.get('view');
  const activeTab: ProfessorTab = requestedTab === 'students' || requestedTab === 'materials' || requestedTab === 'assignments' || requestedTab === 'announcements' ? requestedTab : 'overview';
  const setActiveTab = (next: ProfessorTab) => setSearchParams(next === 'overview' ? {} : { view: next });
  const [loading, setLoading] = useState(false);
  const [studentPage, setStudentPage] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [materialPage, setMaterialPage] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [folderPage, setFolderPage] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [assignmentPage, setAssignmentPage] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [announcementPage, setAnnouncementPage] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const materialCursors = useRef<(string | undefined)[]>([undefined]);
  const [courseLoading, setCourseLoading] = useState(true);
  const [courseError, setCourseError] = useState(false);

  const [course, setCourse] = useState<ProfessorCourse | null>(null);
  const [students, setStudents] = useState<EnrolledStudent[]>([]);
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  const [assignments, setAssignments] = useState<CourseAssignment[]>([]);
  const [announcements, setAnnouncements] = useState<CourseAnnouncement[]>([]);

  const [showAddAssignment, setShowAddAssignment] = useState(false);
  const [showAddAnnouncement, setShowAddAnnouncement] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Array<{ key: string; name: string; percent: number; state: 'uploading' | 'queued' | 'error'; error?: string }>>([]);
  const [dragActive, setDragActive] = useState(false);
  const [newAssignment, setNewAssignment] = useState({ title: '', description: '', questionText: '', dueDate: '', points: 100 });
  const [newAnnouncement, setNewAnnouncement] = useState({ title: '', content: '' });

  // Folder navigation state
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [folders, setFolders] = useState<MaterialFolder[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<FolderCrumb[]>([]);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [retryingMaterialId, setRetryingMaterialId] = useState<number | null>(null);
  const pollAttempt = useRef(0);
  const activeMaterialIds = materials.filter(material => ['uploading', 'queued', 'processing', 'retrying'].includes(material.ingestion_status ?? '')).map(material => material.id).join(',');

  useEffect(() => {
    pollAttempt.current = 0;
  }, [activeTab, currentFolderId]);

  useEffect(() => {
    if (activeTab !== 'materials' || !activeMaterialIds) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const schedule = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      const delay = Math.min(30000, 3000 * 2 ** Math.min(pollAttempt.current, 4));
      timer = setTimeout(async () => {
        if (cancelled || document.visibilityState === 'hidden') return;
        try {
          const responses = await Promise.all(materialCursors.current.map(cursor => professorAPI.getMaterials(currentFolderId, { limit: 20, cursor })));
          if (!cancelled) setMaterials(responses.flatMap(response => response.data.materials));
        } catch {
          // Keep the last known state; retry with bounded backoff while active.
        }
        pollAttempt.current += 1;
        schedule();
      }, delay);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (timer) clearTimeout(timer);
        timer = undefined;
      } else {
        pollAttempt.current = 0;
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeTab, activeMaterialIds, currentFolderId]);

  const loadCourse = useCallback(async () => {
    try {
      setCourseLoading(true);
      setCourseError(false);
      const response = await professorAPI.getCourse();
      setCourse(response.data.course);
    } catch {
      setCourseError(true);
      showToast('Failed to load course', 'error');
    } finally {
      setCourseLoading(false);
    }
  }, [showToast]);

  const loadStudents = useCallback(async (cursor?: string) => {
    try {
      setLoading(true);
      const response = await professorAPI.getStudents({ limit: 20, cursor });
      setStudents(previous => cursor ? [...previous, ...response.data.students] : response.data.students);
      setStudentPage(response.data.page ?? null);
    } catch {
      showToast('Failed to load students', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const loadAssignments = useCallback(async (cursor?: string) => {
    try {
      setLoading(true);
      const response = await professorAPI.getAssignments({ limit: 20, cursor });
      setAssignments(previous => cursor ? [...previous, ...response.data.assignments] : response.data.assignments);
      setAssignmentPage(response.data.page ?? null);
    } catch {
      showToast('Failed to load assignments', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const loadMaterials = useCallback(async (cursor?: string) => {
    try {
      setLoading(true);
      const [materialsRes, foldersRes, breadcrumbRes] = await Promise.all([
        professorAPI.getMaterials(currentFolderId === null ? null : currentFolderId, { limit: 20, cursor }),
        cursor ? Promise.resolve(null) : professorAPI.getFolders(currentFolderId, { limit: 20 }),
        cursor || currentFolderId === null ? Promise.resolve(null) : professorAPI.getFolderBreadcrumb(currentFolderId),
      ]);
      setMaterials(previous => cursor ? [...previous, ...materialsRes.data.materials] : materialsRes.data.materials);
      setMaterialPage(materialsRes.data.page ?? null);
      if (cursor) materialCursors.current.push(cursor);
      else materialCursors.current = [undefined];
      if (foldersRes) {
        setFolders(foldersRes.data.folders);
        setFolderPage(foldersRes.data.page ?? null);
      }
      if (!cursor) setBreadcrumb(breadcrumbRes?.data.breadcrumb ?? []);
    } catch {
      showToast('Failed to load course materials', 'error');
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, showToast]);

  const loadAnnouncements = useCallback(async (cursor?: string) => {
    try {
      setLoading(true);
      const response = await professorAPI.getAnnouncements({ limit: 20, cursor });
      setAnnouncements(previous => cursor ? [...previous, ...response.data.announcements] : response.data.announcements);
      setAnnouncementPage(response.data.page ?? null);
    } catch {
      showToast('Failed to load announcements', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const loadMoreFolders = async () => {
    const cursor = folderPage?.nextCursor;
    if (!cursor) return;
    try {
      setLoading(true);
      const response = await professorAPI.getFolders(currentFolderId, { limit: 20, cursor });
      setFolders(previous => [...previous, ...response.data.folders]);
      setFolderPage(response.data.page ?? null);
    } catch {
      showToast('Could not load more folders', 'error');
    } finally { setLoading(false); }
  };

  useEffect(() => { void loadCourse(); }, [loadCourse]);

  useEffect(() => {
    if (activeTab === 'students') void loadStudents();
    if (activeTab === 'assignments') void loadAssignments();
    if (activeTab === 'announcements') void loadAnnouncements();
  }, [activeTab, loadStudents, loadAssignments, loadAnnouncements]);

  useEffect(() => {
    if (activeTab === 'materials') void loadMaterials();
  }, [activeTab, loadMaterials]);

  const handleAddAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await professorAPI.createAssignment(newAssignment);
      showToast('Assignment created successfully', 'success');
      setNewAssignment({ title: '', description: '', questionText: '', dueDate: '', points: 100 });
      setShowAddAssignment(false);
      loadAssignments();
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to create assignment'), 'error');
    }
  };

  const handleDeleteAssignment = async (id: number) => {
    if (!confirm('Are you sure you want to delete this assignment?')) return;
    try {
      await professorAPI.deleteAssignment(id);
      showToast('Assignment deleted successfully', 'success');
      loadAssignments();
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to delete assignment'), 'error');
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
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to post announcement'), 'error');
    }
  };

  const handleDeleteAnnouncement = async (id: number) => {
    if (!confirm('Are you sure you want to delete this announcement?')) return;
    try {
      await professorAPI.deleteAnnouncement(id);
      showToast('Announcement deleted successfully', 'success');
      loadAnnouncements();
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to delete announcement'), 'error');
    }
  };

  const uploadMaterials = async (files: FileList | File[]) => {
    if (!files.length || uploadingFiles) return;
    const validation = validateByType(files, 'courseMaterials');
    if (!validation.valid) {
      showToast(validation.error || 'Invalid file selection', 'error');
      return;
    }
    const selected = Array.from(files);
    setUploadProgress(selected.map((file, index) => ({ key: `${index}-${file.name}`, name: file.name, percent: 0, state: 'uploading' })));
    let completed = 0;
    try {
      setUploadingFiles(true);
      for (const [index, file] of selected.entries()) {
        const key = `${index}-${file.name}`;
        try {
          await professorAPI.uploadMaterials([file], currentFolderId, event => {
            const percent = event.total ? Math.min(100, Math.round(event.loaded / event.total * 100)) : 0;
            setUploadProgress(previous => previous.map(item => item.key === key ? { ...item, percent } : item));
          });
          completed += 1;
          setUploadProgress(previous => previous.map(item => item.key === key ? { ...item, percent: 100, state: 'queued' } : item));
        } catch {
          setUploadProgress(previous => previous.map(item => item.key === key ? { ...item, state: 'error', error: 'Upload failed. Select this file again to retry.' } : item));
        }
      }
      if (completed) {
        showToast(`${completed} attachment${completed === 1 ? '' : 's'} accepted for indexing`, 'success');
        await loadMaterials();
      }
    } finally {
      setUploadingFiles(false);
    }
  };

  const handleUploadMaterials = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void uploadMaterials(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files.length) void uploadMaterials(event.dataTransfer.files);
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
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to create folder'), 'error');
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
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to delete folder'), 'error');
    }
  };

  const handleDeleteMaterial = async (id: number) => {
    if (!confirm('Are you sure you want to delete this material?')) return;
    try {
      await professorAPI.deleteMaterial(id);
      showToast('Material deleted successfully', 'success');
      loadMaterials();
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to delete material'), 'error');
    }
  };

  const handleDownloadMaterial = async (id: number) => {
    try {
      const response = await professorAPI.downloadMaterial(id);
      window.open(response.data.url, '_blank');
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Failed to download material'), 'error');
    }
  };

  const handleReindexMaterial = async (id: number) => {
    try {
      setRetryingMaterialId(id);
      await professorAPI.reindexMaterial(id);
      showToast('Attachment queued for indexing. Its status updates automatically while this tab is open.', 'success');
      await loadMaterials();
    } catch (error: unknown) {
      showToast(apiErrorMessage(error, 'Could not queue attachment for indexing'), 'error');
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
  if (courseLoading) {
    return <div className="pending-approval" role="status">Loading your teaching workspace...</div>;
  }

  if (courseError) {
    return <div className="pending-approval"><div className="pending-card"><h1>Course unavailable</h1><p>Your course could not be loaded.</p><button type="button" onClick={loadCourse}>Retry</button></div></div>;
  }

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
      <header className="dashboard-header dashboard-header--workspace">
        <div className="header-content">
          <div>
            <h1>Teaching workspace</h1>
            <p>Welcome, {user?.fullName}. Review what needs your attention.</p>
            {course && <p className="course-title">{course.title}</p>}
          </div>
        </div>
      </header>

      <nav aria-label="Teaching sections" className="dashboard-tabs">
        <button type="button" aria-current={activeTab === 'overview' ? 'page' : undefined} className={`tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
          Overview
        </button>
        <button type="button" aria-current={activeTab === 'students' ? 'page' : undefined} className={`tab ${activeTab === 'students' ? 'active' : ''}`} onClick={() => setActiveTab('students')}>
          Students
        </button>
        <button type="button" aria-current={activeTab === 'materials' ? 'page' : undefined} className={`tab ${activeTab === 'materials' ? 'active' : ''}`} onClick={() => setActiveTab('materials')}>
          Course Materials
        </button>
        <button type="button" aria-current={activeTab === 'assignments' ? 'page' : undefined} className={`tab ${activeTab === 'assignments' ? 'active' : ''}`} onClick={() => setActiveTab('assignments')}>
          Assignments
        </button>
        <button type="button" aria-current={activeTab === 'announcements' ? 'page' : undefined} className={`tab ${activeTab === 'announcements' ? 'active' : ''}`} onClick={() => setActiveTab('announcements')}>
          Announcements
        </button>
      </nav>

      <main className="dashboard-main">
        {loading && activeTab !== 'overview' && <div className="loading" role="status">Loading...</div>}

        {activeTab === 'overview' && course && <ProfessorOverview course={course} onTab={setActiveTab} />}

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
                    {students.map((student) => (
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
                <button type="button" className="btn-secondary" onClick={() => void loadMaterials()} disabled={loading}>Refresh status</button>
                <button
                  className="btn-secondary"
                  onClick={() => setShowCreateFolder(true)}
                >
                  + New Folder
                </button>
                <label htmlFor="file-upload" className="btn-primary" style={{ cursor: 'pointer' }}>
                  {uploadingFiles ? 'Uploading...' : 'Choose files'}
                  <input
                    id="file-upload"
                    type="file"
                    multiple
                    accept={getAcceptAttribute()}
                    onChange={handleUploadMaterials}
                    className="upload-file-input"
                    disabled={uploadingFiles}
                  />
                </label>
              </div>
            </div>

            <p className="material-index-help">New attachments wait for the indexing worker, then become available for course answers after processing. Active status updates automatically while this tab is visible. A review warning means some text was not readable; upload a text-based copy for full coverage. Scanned PDFs and images are not text-recognized.</p>
            <div className={`material-dropzone${dragActive ? ' material-dropzone--active' : ''}`} onDragOver={event => event.preventDefault()} onDragEnter={event => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={handleDrop}>
              <strong>Drop course files here</strong>
              <span>Or use Choose files above. Up to 10 files, 10 MB each. PDF, Word, PowerPoint (.ppt and .pptx), spreadsheets, and text files are supported. The server checks file contents.</span>
            </div>
            {uploadProgress.length > 0 && <div className="material-upload-progress"><h3>Upload transfer</h3><ul aria-label="File upload progress">{uploadProgress.map(item => <li key={item.key}><span>{item.name}</span>{item.state === 'uploading' && <progress value={item.percent} max="100" aria-label={`Uploading ${item.name}`}>{item.percent}%</progress>}<span>{item.state === 'uploading' ? item.percent ? `${item.percent}% transferred` : 'Transferring' : item.state === 'queued' ? 'Transfer complete. Indexing status appears below.' : item.error}</span></li>)}</ul></div>}
            {activeMaterialIds && <p className="material-index-help">Checking {activeMaterialIds.split(',').length} active attachment{activeMaterialIds.includes(',') ? 's' : ''} for updates.</p>}

            {/* Breadcrumb Navigation */}
            <div className="folder-breadcrumb">
              <button
                className={`breadcrumb-item ${currentFolderId === null ? 'active' : ''}`}
                onClick={() => setCurrentFolderId(null)}
              >
                🏠 Home
              </button>
              {breadcrumb.map((crumb, index: number) => (
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
                {folders.map((folder) => (
                  <div
                    key={`folder-${folder.id}`}
                    className="material-card folder-card"
                  >
                    <div className="material-icon folder-icon">&#128193;</div>
                    <div className="material-info">
                      <h3><button type="button" className="folder-open-button" onClick={() => setCurrentFolderId(folder.id)}>Open {folder.name}</button></h3>
                      <p className="material-meta">
                        Folder &bull; Created {new Date(folder.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="material-actions">
                      <button
                        className="btn-delete-icon"
                        type="button"
                        aria-label={`Delete folder ${folder.name}`}
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
                {materials.map((material) => (
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
                        type="button"
                        aria-label={`Delete material ${material.file_name}`}
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
                {assignments.map((assignment) => (
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
                {announcements.map((announcement) => (
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
        {activeTab === 'students' && studentPage?.hasMore && <button type="button" className="btn-secondary" disabled={loading} onClick={() => studentPage.nextCursor && void loadStudents(studentPage.nextCursor)}>Load more students</button>}
        {activeTab === 'materials' && materialPage?.hasMore && <button type="button" className="btn-secondary" disabled={loading} onClick={() => materialPage.nextCursor && void loadMaterials(materialPage.nextCursor)}>Load more materials</button>}
        {activeTab === 'materials' && folderPage?.hasMore && <button type="button" className="btn-secondary" disabled={loading} onClick={() => void loadMoreFolders()}>Load more folders</button>}
        {activeTab === 'assignments' && assignmentPage?.hasMore && <button type="button" className="btn-secondary" disabled={loading} onClick={() => assignmentPage.nextCursor && void loadAssignments(assignmentPage.nextCursor)}>Load more assignments</button>}
        {activeTab === 'announcements' && announcementPage?.hasMore && <button type="button" className="btn-secondary" disabled={loading} onClick={() => announcementPage.nextCursor && void loadAnnouncements(announcementPage.nextCursor)}>Load more announcements</button>}
      </main>
    </div>
  );
};

export default ProfessorDashboard;
