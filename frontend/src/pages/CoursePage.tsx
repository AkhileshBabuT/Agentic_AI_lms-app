import React, { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { studentAPI } from '../services/api';
import MaterialIndexStatus from '../components/MaterialIndexStatus';
import { Skeleton, InlineAlert, Button } from '../components/ui';
import { courseQueries } from '../data/queries';
import './CoursePage.css';

interface Assignment { id: number; title: string; due_date?: string; description?: string; points: number }
interface Announcement { id: number; title: string; date: string; content: string; author: string }
interface Folder { id: number; name: string; created_at: string }
interface Material { id: number; file_name: string; file_size: number; uploaded_at: string; ingestion_status?: string; ingestion_warning?: string; ingestion_error?: string; published_run_id?: string | null }
interface Breadcrumb { id: number; name: string }

const CoursePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { user, logout } = useAuth();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('overview');
  // Folder navigation state
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const courseId = Number(id);
  const validId = Number.isSafeInteger(courseId) && courseId > 0;
  const courseQuery = useQuery({ ...courseQueries.studentDetail(courseId), enabled: validId });
  const assignmentsQuery = useInfiniteQuery({ ...courseQueries.assignmentPages(courseId), enabled: validId && activeTab === 'assignments' });
  const announcementsQuery = useInfiniteQuery({ ...courseQueries.announcementPages(courseId), enabled: validId && activeTab === 'announcements' });
  const materialsEnabled = validId && activeTab === 'materials';
  const materialsQuery = useInfiniteQuery({ ...courseQueries.materialPages(courseId, currentFolderId), enabled: materialsEnabled });
  const foldersQuery = useInfiniteQuery({ ...courseQueries.folderPages(courseId, currentFolderId), enabled: materialsEnabled });
  const breadcrumbQuery = useQuery({ ...courseQueries.folderBreadcrumb(courseId, currentFolderId ?? 0), enabled: materialsEnabled && currentFolderId !== null });
  const course = courseQuery.data?.course;
  const assignments: Assignment[] = assignmentsQuery.data?.pages.flatMap(page => page.assignments ?? page.items ?? []) ?? [];
  const announcements: Announcement[] = announcementsQuery.data?.pages.flatMap(page => page.announcements ?? page.items ?? []) ?? [];
  const materials: Material[] = materialsQuery.data?.pages.flatMap(page => page.materials ?? page.items ?? []) ?? [];
  const folders: Folder[] = foldersQuery.data?.pages.flatMap(page => page.folders ?? page.items ?? []) ?? [];
  const breadcrumb: Breadcrumb[] = breadcrumbQuery.data?.breadcrumb ?? [];
  const materialsLoading = materialsQuery.isPending || foldersQuery.isPending;
  const materialError = materialsQuery.isError || foldersQuery.isError || breadcrumbQuery.isError;
  const refreshMaterials = () => { void Promise.all([materialsQuery.refetch(), foldersQuery.refetch(), ...(currentFolderId === null ? [] : [breadcrumbQuery.refetch()])]); };

  const handleDownloadMaterial = async (materialId: number) => {
    try {
      const response = await studentAPI.downloadMaterial(materialId);
      window.open(response.data.url, '_blank');
    } catch (error: unknown) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      showToast(typeof message === 'string' ? message : 'Failed to download material', 'error');
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  if (!validId) return <InlineAlert tone="danger">Invalid course link.</InlineAlert>;
  if (courseQuery.isPending) return <Skeleton label="Loading course" lines={5} />;
  if (courseQuery.isError || !course) return <InlineAlert tone="danger" title="Course unavailable" action={<Button onClick={() => void courseQuery.refetch()}>Retry</Button>}>Could not load this course.</InlineAlert>;

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="overview-content">
            <div className="course-info">
              <h2>Course Overview</h2>
              <p>{course.description}</p>
              <div className="course-details">
                <div className="detail-item">
                  <strong>Instructor:</strong> {course.instructor_name || course.instructor || 'N/A'}
                </div>
                <div className="detail-item">
                  <strong>Progress:</strong> {course.progress || 0}%
                </div>
              </div>
            </div>
            
            <div className="recent-activity">
              <h3>Recent Activity</h3>
              <div className="activity-list">
                <div className="activity-item">
                  <span className="activity-type">Assignment</span>
                  <span className="activity-text">Assignment 3 submitted</span>
                  <span className="activity-date">2 days ago</span>
                </div>
                <div className="activity-item">
                  <span className="activity-type">Announcement</span>
                  <span className="activity-text">New announcement posted</span>
                  <span className="activity-date">3 days ago</span>
                </div>
              </div>
            </div>
          </div>
        );
      
      case 'assignments':
        return (
          <div className="assignments-content">
            <h2>Assignments</h2>
            {assignmentsQuery.isPending && <Skeleton label="Loading assignments" />}
            {assignmentsQuery.isError && <InlineAlert tone="danger" action={<Button onClick={() => void assignmentsQuery.refetch()}>Retry</Button>}>Could not load assignments.</InlineAlert>}
            {!assignmentsQuery.isPending && !assignmentsQuery.isError && assignments.length === 0 ? (
              <p className="empty-message">No assignments available yet</p>
            ) : (
              <div className="assignments-list">
                {assignments.map((assignment) => (
                  <Link
                    key={assignment.id}
                    to={`/assignments/${assignment.id}`}
                    className="assignment-item-link"
                  >
                    <div className="assignment-item">
                      <div className="assignment-header">
                        <h3>{assignment.title}</h3>
                        {assignment.due_date && (
                          <span className="due-date">
                            Due: {new Date(assignment.due_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      {assignment.description && (
                        <p className="assignment-description">{assignment.description}</p>
                      )}
                      <div className="assignment-footer">
                        <span className="points">{assignment.points} points</span>
                        <span className="view-button">View Assignment →</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
            {assignmentsQuery.hasNextPage && <Button variant="secondary" loading={assignmentsQuery.isFetchingNextPage} onClick={() => void assignmentsQuery.fetchNextPage()}>Load more assignments</Button>}
          </div>
        );
      
      case 'announcements':
        return (
          <div className="announcements-content">
            <h2>Announcements</h2>
            {announcementsQuery.isPending && <Skeleton label="Loading announcements" />}
            {announcementsQuery.isError && <InlineAlert tone="danger" action={<Button onClick={() => void announcementsQuery.refetch()}>Retry</Button>}>Could not load announcements.</InlineAlert>}
            <div className="announcements-list">
              {announcements.map((announcement) => (
                <div key={announcement.id} className="announcement-item">
                  <div className="announcement-header">
                    <h3>{announcement.title}</h3>
                    <span className="announcement-date">{announcement.date}</span>
                  </div>
                  <p className="announcement-content">{announcement.content}</p>
                  <div className="announcement-author">
                    Posted by {announcement.author}
                  </div>
                </div>
              ))}
            </div>
            {announcementsQuery.hasNextPage && <Button variant="secondary" loading={announcementsQuery.isFetchingNextPage} onClick={() => void announcementsQuery.fetchNextPage()}>Load more announcements</Button>}
          </div>
        );
      
      case 'materials':
        return (
          <div className="materials-content">
            <h2>Course Materials</h2>
            <button type="button" className="btn-secondary" onClick={refreshMaterials} disabled={materialsQuery.isFetching || foldersQuery.isFetching}>Refresh status</button>
            {materialError && <InlineAlert tone="danger" action={<Button onClick={refreshMaterials}>Retry</Button>}>Could not load course materials.</InlineAlert>}

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

            {materialsLoading ? (
              <Skeleton label="Loading materials" />
            ) : !materialError && folders.length === 0 && materials.length === 0 ? (
              <p className="empty-message">
                {currentFolderId === null
                  ? 'No course materials available yet'
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
                      <MaterialIndexStatus material={material} />
                    </div>
                    <div className="material-actions">
                      <button
                        className="btn-primary"
                        onClick={() => handleDownloadMaterial(material.id)}
                      >
                        Download
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {foldersQuery.hasNextPage && <Button variant="secondary" loading={foldersQuery.isFetchingNextPage} onClick={() => void foldersQuery.fetchNextPage()}>Load more folders</Button>}
            {materialsQuery.hasNextPage && <Button variant="secondary" loading={materialsQuery.isFetchingNextPage} onClick={() => void materialsQuery.fetchNextPage()}>Load more materials</Button>}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="course-page">
      <header className="course-header">
        <div className="header-content">
          <div className="breadcrumb">
            <Link to="/dashboard">← Back to Dashboard</Link>
          </div>
          <div className="header-title">
            <h1>{course.title}</h1>
            <p className="course-instructor-header">Instructor: {course.instructor_name || course.instructor || 'N/A'}</p>
          </div>
          <div className="header-actions">
            <span className="user-info">Welcome, {user?.fullName}</span>
            <button onClick={logout} className="logout-button">
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="course-main">
        <div className="course-container">
          <div className="course-tabs">
            <button 
              className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            <button 
              className={`tab ${activeTab === 'assignments' ? 'active' : ''}`}
              onClick={() => setActiveTab('assignments')}
            >
              Assignments
            </button>
            <button 
              className={`tab ${activeTab === 'announcements' ? 'active' : ''}`}
              onClick={() => setActiveTab('announcements')}
            >
              Announcements
            </button>
            <button
              className={`tab ${activeTab === 'materials' ? 'active' : ''}`}
              onClick={() => setActiveTab('materials')}
            >
              Materials
            </button>
          </div>

          <div className="course-content">
            {renderTabContent()}
          </div>
        </div>
      </main>
    </div>
  );
};

export default CoursePage;
