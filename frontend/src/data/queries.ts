import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { chatAPI, materialSourcesAPI, rootAPI, studentAPI, type CursorParams } from '../services/api';
import { queryKeys } from './queryKeys';

export const courseQueries = {
  studentList: (page?: CursorParams) => queryOptions({
    queryKey: [...queryKeys.courses, page?.cursor ?? null, page?.limit ?? 20] as const,
    queryFn: ({ signal }) => studentAPI.getCourses(signal, page).then(response => response.data),
    staleTime: 60_000,
  }),
  studentDetail: (courseId: number) => queryOptions({
    queryKey: queryKeys.course(courseId),
    queryFn: ({ signal }) => studentAPI.getCourseDetails(courseId, signal).then(response => response.data),
    staleTime: 60_000,
  }),
  assignments: (courseId: number) => queryOptions({
    queryKey: queryKeys.assignments(courseId),
    queryFn: ({ signal }) => studentAPI.getCourseAssignments(courseId, signal).then(response => response.data),
    staleTime: 30_000,
  }),
  announcements: (courseId: number) => queryOptions({
    queryKey: queryKeys.announcements(courseId),
    queryFn: ({ signal }) => studentAPI.getCourseAnnouncements(courseId, signal).then(response => response.data),
    staleTime: 30_000,
  }),
  materials: (courseId: number, folderId: number | null) => queryOptions({
    queryKey: queryKeys.materials(courseId, folderId),
    queryFn: ({ signal }) => studentAPI.getCourseMaterials(courseId, folderId, signal).then(response => response.data),
    staleTime: 5_000,
  }),
  folders: (courseId: number, folderId: number | null) => queryOptions({
    queryKey: queryKeys.folders(courseId, folderId),
    queryFn: ({ signal }) => studentAPI.getCourseFolders(courseId, folderId, signal).then(response => response.data),
    staleTime: 30_000,
  }),
  folderBreadcrumb: (courseId: number, folderId: number) => queryOptions({
    queryKey: queryKeys.folderBreadcrumb(courseId, folderId),
    queryFn: ({ signal }) => studentAPI.getCourseFolderBreadcrumb(courseId, folderId, signal).then(response => response.data),
    staleTime: 60_000,
  }),
  assignmentPages: (courseId: number) => infiniteQueryOptions({
    queryKey: [...queryKeys.assignments(courseId), 'pages'] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => studentAPI.getCourseAssignments(courseId, signal, { limit: 20, cursor: pageParam }).then(response => response.data),
    getNextPageParam: lastPage => lastPage.page?.hasMore ? lastPage.page.nextCursor ?? undefined : undefined,
    staleTime: 30_000,
  }),
  announcementPages: (courseId: number) => infiniteQueryOptions({
    queryKey: [...queryKeys.announcements(courseId), 'pages'] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => studentAPI.getCourseAnnouncements(courseId, signal, { limit: 20, cursor: pageParam }).then(response => response.data),
    getNextPageParam: lastPage => lastPage.page?.hasMore ? lastPage.page.nextCursor ?? undefined : undefined,
    staleTime: 30_000,
  }),
  materialPages: (courseId: number, folderId: number | null) => infiniteQueryOptions({
    queryKey: [...queryKeys.materials(courseId, folderId), 'pages'] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => studentAPI.getCourseMaterials(courseId, folderId, signal, { limit: 20, cursor: pageParam }).then(response => response.data),
    getNextPageParam: lastPage => lastPage.page?.hasMore ? lastPage.page.nextCursor ?? undefined : undefined,
    staleTime: 5_000,
  }),
  folderPages: (courseId: number, folderId: number | null) => infiniteQueryOptions({
    queryKey: [...queryKeys.folders(courseId, folderId), 'pages'] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => studentAPI.getCourseFolders(courseId, folderId, signal, { limit: 20, cursor: pageParam }).then(response => response.data),
    getNextPageParam: lastPage => lastPage.page?.hasMore ? lastPage.page.nextCursor ?? undefined : undefined,
    staleTime: 30_000,
  }),
};

export const chatQueries = {
  courses: () => queryOptions({
    queryKey: queryKeys.chatCourses,
    queryFn: ({ signal }) => chatAPI.getCourses(signal).then(response => response.data),
    staleTime: 60_000,
  }),
  generatedContent: () => queryOptions({
    queryKey: queryKeys.generatedContent(true),
    queryFn: ({ signal }) => chatAPI.getGeneratedContent({ isSaved: true }, signal).then(response => response.data),
    staleTime: 30_000,
  }),
  sessions: (filters?: { courseId?: number; status?: string }) => queryOptions({
    queryKey: queryKeys.sessions(filters),
    queryFn: ({ signal }) => chatAPI.getSessions(filters, signal).then(response => response.data),
    staleTime: 10_000,
  }),
  messages: (sessionId: number) => queryOptions({
    queryKey: queryKeys.messages(sessionId),
    queryFn: ({ signal }) => chatAPI.getMessages(sessionId, undefined, signal).then(response => response.data),
    staleTime: 5_000,
  }),
  sources: (messageId: number) => queryOptions({
    queryKey: queryKeys.sources(messageId),
    queryFn: ({ signal }) => materialSourcesAPI.getAnswer(messageId, signal).then(response => response.data),
    staleTime: 5 * 60_000,
  }),
};

export const rootQueries = {
  stats: () => queryOptions({
    queryKey: queryKeys.rootStats,
    queryFn: ({ signal }) => rootAPI.getStats(signal).then(response => response.data),
    staleTime: 30_000,
  }),
};
