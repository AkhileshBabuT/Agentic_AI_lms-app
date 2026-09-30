import axios, { type AxiosProgressEvent } from 'axios';
import type { AnswerReferences, SourceAccess } from '../types/rag';

export interface CursorParams { limit?: number; cursor?: string }

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

// Create axios instance
const apiClient = axios.create({
  baseURL: API_BASE_URL,
});

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Root API
export const rootAPI = {
  getPendingProfessors: (params?: CursorParams) =>
    apiClient.get('/root/professors/pending', { params }),

  updateProfessorStatus: (professorId: number, status: string) =>
    apiClient.patch(`/root/professors/${professorId}/status`, { status }),

  getUsers: (params?: { role?: string; status?: string } & CursorParams) =>
    apiClient.get('/root/users', { params }),

  deleteUser: (userId: number) =>
    apiClient.delete(`/root/users/${userId}`),

  getCourses: (params?: CursorParams) =>
    apiClient.get('/root/courses', { params }),

  createCourse: (data: { title: string; description?: string; instructorId?: number }) =>
    apiClient.post('/root/courses', data),

  updateCourse: (courseId: number, data: { title?: string; description?: string; instructorId?: number }) =>
    apiClient.put(`/root/courses/${courseId}`, data),

  deleteCourse: (courseId: number) =>
    apiClient.delete(`/root/courses/${courseId}`),

  getEnrollments: () =>
    apiClient.get('/root/enrollments'),

  getStats: (signal?: AbortSignal) =>
    apiClient.get('/root/stats', { signal }),

  getProfessors: (params?: CursorParams) =>
    apiClient.get('/root/professors', { params }),

  assignCourse: (professorId: number, courseId: number) =>
    apiClient.post(`/root/professors/${professorId}/courses`, { courseId }),

  removeCourse: (professorId: number, courseId: number) =>
    apiClient.delete(`/root/professors/${professorId}/courses/${courseId}`),

  deleteProfessor: (professorId: number) =>
    apiClient.delete(`/root/users/${professorId}`),

  // File management
  getAllMaterials: (params?: { courseId?: number; professorId?: number } & CursorParams) =>
    apiClient.get('/root/files/materials', { params }),

  getAllSubmissions: (params?: { courseId?: number; studentId?: number; assignmentId?: number } & CursorParams) =>
    apiClient.get('/root/files/submissions', { params }),

  getFileStats: () =>
    apiClient.get('/root/files/stats'),

  downloadFile: (type: 'material' | 'submission' | 'assignment', fileId: number) =>
    apiClient.get(`/root/files/download/${type}/${fileId}`),

  // AI source-of-truth mode
  getSourceOfTruth: () =>
    apiClient.get('/root/settings/source-of-truth'),

  setSourceOfTruth: (mode: 'strict' | 'external') =>
    apiClient.put('/root/settings/source-of-truth', { mode }),
};

// Usage API (root admin only)
export const usageAPI = {
  getSummary: (params?: { actionType?: string; startDate?: string; endDate?: string }) =>
    apiClient.get('/usage/summary', { params }),

  getLogs: (params?: { userId?: number; actionType?: string; startDate?: string; endDate?: string; limit?: number; offset?: number }) =>
    apiClient.get('/usage/logs', { params }),

  getStats: () =>
    apiClient.get('/usage/stats'),
};

// Professor API
export const professorAPI = {
  getCourse: () =>
    apiClient.get('/professor/course'),

  getStudents: (params?: CursorParams) =>
    apiClient.get('/professor/students', { params }),

  updateCourse: (data: { title?: string; description?: string }) =>
    apiClient.put('/professor/course', data),

  getAssignments: (params?: CursorParams) =>
    apiClient.get('/professor/assignments', { params }),

  getAssignment: (assignmentId: number, signal?: AbortSignal) =>
    apiClient.get(`/professor/assignments/${assignmentId}`, { signal }),

  createAssignment: (data: { title: string; description?: string; questionText?: string; dueDate?: string; points?: number }) =>
    apiClient.post('/professor/assignments', data),

  updateAssignment: (assignmentId: number, data: { title?: string; description?: string; questionText?: string; dueDate?: string; points?: number }) =>
    apiClient.put(`/professor/assignments/${assignmentId}`, data),

  deleteAssignment: (assignmentId: number) =>
    apiClient.delete(`/professor/assignments/${assignmentId}`),

  getAnnouncements: (params?: CursorParams) =>
    apiClient.get('/professor/announcements', { params }),

  createAnnouncement: (data: { title: string; content: string }) =>
    apiClient.post('/professor/announcements', data),

  updateAnnouncement: (announcementId: number, data: { title?: string; content?: string }) =>
    apiClient.put(`/professor/announcements/${announcementId}`, data),

  deleteAnnouncement: (announcementId: number) =>
    apiClient.delete(`/professor/announcements/${announcementId}`),

  // Course Materials
  getMaterials: (folderId?: number | null, page?: CursorParams) =>
    apiClient.get('/professor/materials', {
      params: { ...(folderId !== undefined ? { folderId: folderId === null ? 'null' : folderId } : {}), ...page }
    }),

  uploadMaterials: (files: FileList | File[], folderId?: number | null, onUploadProgress?: (event: AxiosProgressEvent) => void) => {
    const formData = new FormData();
    Array.from(files).forEach((file) => {
      formData.append('files', file);
    });
    if (folderId) {
      formData.append('folderId', folderId.toString());
    }
    return apiClient.post('/professor/materials', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
    });
  },

  deleteMaterial: (materialId: number) =>
    apiClient.delete(`/professor/materials/${materialId}`),

  reindexMaterial: (materialId: number) =>
    apiClient.post(`/professor/materials/${materialId}/reindex`),

  downloadMaterial: (materialId: number) =>
    apiClient.get(`/professor/materials/${materialId}/download`),

  // Material Folders
  getFolders: (folderId?: number | null, page?: CursorParams) =>
    apiClient.get('/professor/folders', {
      params: { ...(folderId ? { folderId } : {}), ...page }
    }),

  createFolder: (data: { name: string; parentId?: number | null }) =>
    apiClient.post('/professor/folders', data),

  renameFolder: (folderId: number, name: string) =>
    apiClient.put(`/professor/folders/${folderId}`, { name }),

  deleteFolder: (folderId: number) =>
    apiClient.delete(`/professor/folders/${folderId}`),

  getFolderBreadcrumb: (folderId: number) =>
    apiClient.get(`/professor/folders/${folderId}/breadcrumb`),

  // Assignment Files
  getAssignmentFiles: (assignmentId: number, params?: CursorParams) =>
    apiClient.get(`/professor/assignments/${assignmentId}/files`, { params }),

  uploadAssignmentFiles: (assignmentId: number, files: FileList) => {
    const formData = new FormData();
    Array.from(files).forEach((file) => {
      formData.append('files', file);
    });
    return apiClient.post(`/professor/assignments/${assignmentId}/files`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  deleteAssignmentFile: (assignmentId: number, fileId: number) =>
    apiClient.delete(`/professor/assignments/${assignmentId}/files/${fileId}`),

  // Submissions
  getSubmissions: (assignmentId: number, params?: CursorParams & { gradeState?: 'all' | 'graded' | 'ungraded'; student?: string; sort?: 'submitted_desc' | 'submitted_asc' | 'student_asc' | 'student_desc' }) =>
    apiClient.get(`/professor/assignments/${assignmentId}/submissions`, { params }),

  gradeSubmission: (submissionId: number, data: { grade: number; feedback?: string }) =>
    apiClient.put(`/professor/submissions/${submissionId}/grade`, data),

  downloadSubmissionFile: (fileId: number) =>
    apiClient.get(`/professor/submissions/files/${fileId}/download`),
};

// Student API
export const studentAPI = {
  getCourses: (signal?: AbortSignal, params?: CursorParams) =>
    apiClient.get('/student/courses', { signal, params }),

  getMyCourses: (params?: CursorParams, signal?: AbortSignal) =>
    apiClient.get('/student/my-courses', { params, signal }),

  enrollInCourse: (courseId: number) =>
    apiClient.post(`/student/courses/${courseId}/enroll`),

  unenrollFromCourse: (courseId: number) =>
    apiClient.delete(`/student/courses/${courseId}/enroll`),

  getCourseDetails: (courseId: number, signal?: AbortSignal) =>
    apiClient.get(`/student/courses/${courseId}`, { signal }),

  getCourseAssignments: (courseId: number, signal?: AbortSignal, params?: CursorParams) =>
    apiClient.get(`/student/courses/${courseId}/assignments`, { signal, params }),

  getCourseAnnouncements: (courseId: number, signal?: AbortSignal, params?: CursorParams) =>
    apiClient.get(`/student/courses/${courseId}/announcements`, { signal, params }),

  // Course Materials
  getCourseMaterials: (courseId: number, folderId?: number | null, signal?: AbortSignal, page?: CursorParams) =>
    apiClient.get(`/student/courses/${courseId}/materials`, {
      params: { ...(folderId !== undefined ? { folderId: folderId === null ? 'null' : folderId } : {}), ...page }, signal
    }),

  getCourseFolders: (courseId: number, folderId?: number | null, signal?: AbortSignal, page?: CursorParams) =>
    apiClient.get(`/student/courses/${courseId}/folders`, {
      params: { ...(folderId ? { folderId } : {}), ...page }, signal
    }),

  getCourseFolderBreadcrumb: (courseId: number, folderId: number, signal?: AbortSignal) =>
    apiClient.get(`/student/courses/${courseId}/folders/${folderId}/breadcrumb`, { signal }),

  downloadMaterial: (materialId: number) =>
    apiClient.get(`/student/materials/${materialId}/download`),

  // Assignments
  getAssignment: (assignmentId: number) =>
    apiClient.get(`/student/assignments/${assignmentId}`),

  submitAssignment: (assignmentId: number, data: { submissionText?: string; files?: FileList }) => {
    const formData = new FormData();
    if (data.submissionText) {
      formData.append('submissionText', data.submissionText);
    }
    if (data.files) {
      Array.from(data.files).forEach((file) => {
        formData.append('files', file);
      });
    }
    return apiClient.post(`/student/assignments/${assignmentId}/submit`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  getMySubmission: (assignmentId: number) =>
    apiClient.get(`/student/assignments/${assignmentId}/my-submission`),

  downloadAssignmentFile: (fileId: number) =>
    apiClient.get(`/student/assignments/files/${fileId}/download`),
};

// Chat API
export const chatAPI = {
  // Get enrolled courses for chat
  getCourses: (signal?: AbortSignal) =>
    apiClient.get('/chat/courses', { signal }),

  // Create or get chat session
  createSession: (courseId: number) =>
    apiClient.post('/chat/sessions', { courseId }),

  // Get all sessions
  getSessions: (params?: { courseId?: number; status?: string; limit?: number; cursor?: string }, signal?: AbortSignal) =>
    apiClient.get('/chat/sessions', { params, signal }),

  getSession: (sessionId: number, signal?: AbortSignal) =>
    apiClient.get(`/chat/sessions/${sessionId}`, { signal }),

  // Get messages for a session
  getMessages: (sessionId: number, params?: { limit?: number; cursor?: string }, signal?: AbortSignal) =>
    apiClient.get(`/chat/sessions/${sessionId}/messages`, { params, signal }),

  // Send a message
  sendMessage: (sessionId: number, content: string) =>
    apiClient.post(`/chat/sessions/${sessionId}/messages`, { content }),

  // Archive a session
  archiveSession: (sessionId: number) =>
    apiClient.patch(`/chat/sessions/${sessionId}/archive`),

  // Regenerate last response
  regenerateResponse: (sessionId: number) =>
    apiClient.post(`/chat/sessions/${sessionId}/regenerate`),

  // Get generated content
  getGeneratedContent: (params?: { courseId?: number; contentType?: string; isSaved?: boolean }, signal?: AbortSignal) =>
    apiClient.get('/chat/generated-content', { params, signal }),

  // Save generated content
  saveGeneratedContent: (data: {
    sessionId: number;
    contentType: string;
    title?: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) =>
    apiClient.post('/chat/generated-content', data),

  // Delete generated content
  deleteGeneratedContent: (contentId: number) =>
    apiClient.delete(`/chat/generated-content/${contentId}`),

  // Get sources for a message
  getSources: (messageId: number) =>
    apiClient.get(`/chat/messages/${messageId}/sources`),

};

/** Fresh authorization checks: never resolve documents using historical metadata URLs. */
export const materialSourcesAPI = {
  getSavedContent: (contentId: number, signal?: AbortSignal) =>
    apiClient.get<AnswerReferences>(`/material-sources/saved/${contentId}`, { signal }),
  getAnswer: (messageId: number, signal?: AbortSignal) =>
    apiClient.get<AnswerReferences>(`/material-sources/answers/${messageId}`, { signal }),
  resolve: (chunkId: string, signal?: AbortSignal) =>
    apiClient.get<SourceAccess>(`/material-sources/${encodeURIComponent(chunkId)}`, { signal }),
};

// Grading Assistant API
export const gradingAssistantAPI = {
  // Generate tentative grade for a submission
  generateTentativeGrade: (submissionId: number) =>
    apiClient.post('/grading-assistant/generate-tentative-grade', { submissionId }),

  // Get tentative grade for a submission
  getTentativeGrade: (submissionId: number) =>
    apiClient.get(`/grading-assistant/tentative-grade/${submissionId}`),

  // Finalize a tentative grade (Professor only)
  finalizeGrade: (tentativeGradeId: number, data: { finalGrade: number; feedback: string }) =>
    apiClient.post(`/grading-assistant/finalize-grade/${tentativeGradeId}`, data),

  // Create grading rubric for an assignment (Professor only)
  createRubric: (data: {
    assignmentId: number;
    rubricName: string;
    criteria: Array<{
      name: string;
      description: string;
      points: number;
      excellent_description?: string;
      good_description?: string;
      fair_description?: string;
      poor_description?: string;
    }>;
    totalPoints: number;
  }) =>
    apiClient.post('/grading-assistant/create-rubric', data),

  // Get rubric for an assignment
  getRubric: (assignmentId: number) =>
    apiClient.get(`/grading-assistant/rubric/${assignmentId}`),
};

export default apiClient;
