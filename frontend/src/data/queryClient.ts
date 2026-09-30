import { QueryClient } from '@tanstack/react-query';
import axios from 'axios';

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2 || axios.isCancel(error)) return false;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status === undefined || status >= 500 || status === 408 || status === 429;
  }
  return false;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
