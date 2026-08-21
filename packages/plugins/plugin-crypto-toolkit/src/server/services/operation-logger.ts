import type { Repository } from '@nocobase/database';

export interface OperationLogInput {
  action: string;
  status?: 'success' | 'error';
  algorithm?: string;
  keyId?: number | null;
  partnerKeyId?: number | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  inputSha256?: string | null;
  outputSha256?: string | null;
  inputAttachmentId?: number | null;
  outputAttachmentId?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  userId?: number | null;
}

interface OperationLoggerApp {
  db: {
    getRepository(name: string): Repository;
  };
  getCurrentUser?(): { id?: number } | undefined;
}

function coerceBigInt(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(Math.max(0, Math.floor(value)));
}

/**
 * Insert a row into cryptoOperations, but never throw / block the caller.
 * Logging is best-effort; if it fails, the operation itself still succeeded.
 */
export async function logOperation(
  appOrRepo: OperationLoggerApp | Repository,
  input: OperationLogInput,
): Promise<void> {
  try {
    const isRepo = (c: unknown): c is Repository =>
      !!c && typeof (c as Repository).create === 'function' && !!(c as Repository).collection;
    const repo: Repository = isRepo(appOrRepo)
      ? appOrRepo
      : (appOrRepo as OperationLoggerApp).db.getRepository('cryptoOperations');
    await repo.create({
      values: {
        action: input.action,
        status: input.status ?? 'success',
        algorithm: input.algorithm ?? null,
        keyId: coerceBigInt(input.keyId ?? null),
        partnerKeyId: coerceBigInt(input.partnerKeyId ?? null),
        inputBytes: coerceBigInt(input.inputBytes ?? null),
        outputBytes: coerceBigInt(input.outputBytes ?? null),
        inputSha256: input.inputSha256 ?? null,
        outputSha256: input.outputSha256 ?? null,
        inputAttachmentId: coerceBigInt(input.inputAttachmentId ?? null),
        outputAttachmentId: coerceBigInt(input.outputAttachmentId ?? null),
        durationMs: input.durationMs ?? null,
        errorMessage: input.errorMessage ?? null,
        userId: coerceBigInt(input.userId ?? null),
      },
    });
  } catch (error) {
    // Defensive — log to stderr only; never let logging bring down an operation.
    // eslint-disable-next-line no-console
    console.warn(
      `[plugin-crypto-toolkit] logOperation failed for action=${input.action}: ${
        (error as Error).message ?? String(error)
      }`,
    );
  }
}
