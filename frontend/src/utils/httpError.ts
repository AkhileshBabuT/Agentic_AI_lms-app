/** Safely extract a server supplied user-facing error from an unknown request failure. */
export function httpErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback;
  const response = (error as { response?: { data?: { error?: unknown } } }).response;
  return typeof response?.data?.error === 'string' && response.data.error.length <= 200
    ? response.data.error : fallback;
}
