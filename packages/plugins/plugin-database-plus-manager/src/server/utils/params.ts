function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readParam<T = unknown>(ctx, key: string, fallback?: T): T {
  const params = ctx.action?.params;
  const sources: Array<Record<string, unknown> | undefined> = [
    isRecord(params?.values) ? params.values : undefined,
    isRecord(params?.data) ? params.data : undefined,
    isRecord(params) ? params : undefined,
    isRecord(ctx.request?.body) ? ctx.request.body : undefined,
  ];
  for (const source of sources) {
    if (source && key in source && source[key] !== undefined) {
      return source[key] as T;
    }
  }
  return fallback as T;
}
