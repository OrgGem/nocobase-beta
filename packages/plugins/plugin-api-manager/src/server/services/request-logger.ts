import type { Database } from '@nocobase/database';

export interface RequestLogEntry {
  requestId: string;
  routeId?: number | null;
  routeName?: string | null;
  direction?: string | null;
  method?: string | null;
  path?: string | null;
  partnerId?: number | null;
  apiKeyId?: number | null;
  userId?: number | null;
  roleName?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  status: 'ok' | 'rejected' | 'failed';
  httpStatus?: number | null;
  upstreamStatus?: number | null;
  attempt?: number | null;
  errorCode?: string | null;
  error?: string | null;
  requestBytes?: number | null;
  responseBytes?: number | null;
  requestSha256?: string | null;
  responseSha256?: string | null;
  requestPayload?: string | null;
  responsePayload?: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
}

export const MAX_LOG_PAYLOAD_BYTES = 1024 * 1024;

export function capPayload(buffer: Buffer): string | null {
  if (buffer.length === 0) return null;
  if (buffer.length > MAX_LOG_PAYLOAD_BYTES) return null;
  return buffer.toString('base64');
}

export async function writeRequestLog(db: Database, entry: RequestLogEntry): Promise<void> {
  const repo = db.getRepository('apiRequestLogs');
  await repo.create({ values: entry });
}

export async function pruneExpiredLogs(db: Database, retentionDays: number): Promise<number> {
  const repo = db.getRepository('apiRequestLogs');
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return repo.destroy({ filter: { createdAt: { $lt: cutoff.toISOString() } } });
}
