import { serverRequest } from '@nocobase/utils';
import type { AxiosError, AxiosResponseHeaders, RawAxiosRequestHeaders } from 'axios';
import { ERROR_CODES } from '../../constants';
import { ApimError } from './errors';

export interface ForwardRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  attempt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error: unknown): boolean {
  const err = error as AxiosError | undefined;
  if (!err) return false;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return true;
  return /timeout/i.test(err.message ?? '');
}

function normalizeResponseHeaders(headers: AxiosResponseHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

export async function forwardRequest(request: ForwardRequest): Promise<ForwardResult> {
  const totalAttempts = Math.max(1, request.retryCount + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const response = await serverRequest<ArrayBuffer>({
        url: request.url,
        method: request.method,
        headers: request.headers as RawAxiosRequestHeaders,
        data: request.body,
        timeout: request.timeoutMs,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: () => true,
      });

      const status = response.status;
      const body = Buffer.from(response.data ?? new ArrayBuffer(0));

      if (status >= 500 && attempt < totalAttempts) {
        await sleep(request.retryDelayMs);
        continue;
      }

      return { status, headers: normalizeResponseHeaders(response.headers), body, attempt };
    } catch (error) {
      lastError = error;
      if (attempt < totalAttempts) {
        await sleep(request.retryDelayMs);
        continue;
      }
    }
  }

  if (isTimeoutError(lastError)) {
    throw new ApimError(ERROR_CODES.TIMEOUT, `Upstream request timed out: ${(lastError as Error).message}`, 504);
  }
  throw new ApimError(
    ERROR_CODES.UPSTREAM_ERROR,
    `Upstream request failed: ${(lastError as Error)?.message ?? 'unknown error'}`,
    502,
  );
}
