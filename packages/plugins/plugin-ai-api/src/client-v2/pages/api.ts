export interface ApiEnvelope<T> {
  data?: {
    data?: T;
    meta?: { count?: number };
  };
}

export function unwrapData<T>(response: unknown, fallback: T): T {
  if (!response || typeof response !== 'object') return fallback;
  const outer = response as ApiEnvelope<T>;
  return outer.data?.data ?? fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
