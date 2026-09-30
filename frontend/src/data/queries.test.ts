import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { courseQueries } from './queries';
import { studentAPI } from '../services/api';

vi.mock('../services/api', () => ({
  studentAPI: { getCourses: vi.fn(), getCourseMaterials: vi.fn() },
  chatAPI: {},
  rootAPI: {},
  materialSourcesAPI: {},
}));

afterEach(() => { vi.clearAllMocks(); });

describe('student course queries', () => {
  it('shares one request between concurrent readers and serves the result from cache', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getCourses = vi.mocked(studentAPI.getCourses);
    getCourses.mockResolvedValue({ data: [{ id: 1, title: 'Physics' }] } as Awaited<ReturnType<typeof studentAPI.getCourses>>);

    const query = courseQueries.studentList();
    const [first, second] = await Promise.all([client.fetchQuery(query), client.fetchQuery(query)]);
    expect(first).toEqual([{ id: 1, title: 'Physics' }]);
    expect(second).toEqual(first);
    expect(getCourses).toHaveBeenCalledTimes(1);

    expect(await client.fetchQuery(query)).toEqual(first);
    expect(getCourses).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('aborts an obsolete request when the query is cancelled', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getCourses = vi.mocked(studentAPI.getCourses);
    let observedSignal: AbortSignal | undefined;
    getCourses.mockImplementation((signal) => {
      observedSignal = signal;
      return new Promise(() => undefined);
    });

    const pending = client.fetchQuery(courseQueries.studentList());
    await client.cancelQueries({ queryKey: courseQueries.studentList().queryKey });
    await expect(pending).rejects.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    client.clear();
  });

  it('deduplicates one folder while keeping another folder separate', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getMaterials = vi.mocked(studentAPI.getCourseMaterials);
    getMaterials.mockResolvedValue({ data: { materials: [] } } as Awaited<ReturnType<typeof studentAPI.getCourseMaterials>>);
    const firstFolder = courseQueries.materials(8, 1);
    const secondFolder = courseQueries.materials(8, 2);

    await Promise.all([client.fetchQuery(firstFolder), client.fetchQuery(firstFolder)]);
    expect(getMaterials).toHaveBeenCalledTimes(1);
    await client.fetchQuery(secondFolder);
    expect(getMaterials).toHaveBeenCalledTimes(2);
    client.clear();
  });
});
