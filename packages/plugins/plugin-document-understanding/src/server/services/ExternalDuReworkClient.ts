// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type {
  DocumentSelection,
  OperationView,
  ProblemDetails,
  ResultEnvelope,
  SubmissionArtifactRef,
} from '../contracts/du-contracts';
import type { ServiceConfig } from '../types';
import { DuHttpError, type ArtifactRecord } from './ArtifactStorageService';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Optional API connector for delegating execution to an external `du-rework` Orchestrator (:3000)
 * using the canonical 2-step Upload Gateway, Idempotency-Key + Retry-After backoff,
 * 12-state Operation polling, HITL resume/cancel, and ResultEnvelope + Artifact download.
 */
export class ExternalDuReworkClient {
  private readonly config: ServiceConfig;
  private readonly http: AxiosInstance;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/+$/, ''),
      timeout: config.defaultTimeout || 30_000,
    });
  }

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!this.config.authType || this.config.authType === 'none' || !this.config.authKey) {
      return headers;
    }
    if (this.config.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.config.authKey}`;
    } else if (this.config.authType === 'api_key') {
      headers[this.config.authHeaderName || 'x-api-key'] = this.config.authKey;
    } else if (this.config.authType === 'custom_header' && this.config.authHeaderName) {
      headers[this.config.authHeaderName] = this.config.authKey;
    }
    return headers;
  }

  private async requestWithRetry<T>(
    reqConfig: AxiosRequestConfig,
    maxRetries = this.config.defaultRetries ?? 2,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const res = await this.http.request<T>({
          ...reqConfig,
          headers: {
            ...this.buildAuthHeaders(),
            ...(reqConfig.headers || {}),
          },
        });
        return res.data;
      } catch (err: unknown) {
        const axiosErr = err as {
          response?: { status: number; data?: unknown; headers?: Record<string, string> };
          message?: string;
        };
        const status = axiosErr.response?.status;
        // Per BRD Section 5: retry 429 / 503 with exponential backoff + Retry-After while keeping Idempotency-Key
        if ((status === 429 || status === 503) && attempt < maxRetries) {
          const retryAfterHeader = Number(axiosErr.response?.headers?.['retry-after']);
          const delayMs =
            Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
              ? retryAfterHeader * 1000
              : Math.min(1000 * 2 ** attempt, 10_000);
          await sleep(delayMs);
          continue;
        }
        if (axiosErr.response && isRecord(axiosErr.response.data) && typeof axiosErr.response.data.code === 'string') {
          throw new DuHttpError(axiosErr.response.data as unknown as ProblemDetails);
        }
        throw err;
      }
    }
    throw new Error('Retry loop exhausted');
  }

  async uploadArtifact(artifact: ArtifactRecord, buffer: Buffer): Promise<string> {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const uploadToken = crypto.randomUUID();
    const initRes = await this.requestWithRetry<{ artifactId: string; uploadUrl?: string }>({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: {
        'Idempotency-Key': `upload-${artifact.artifactId}`,
        'Content-Type': 'application/json',
      },
      data: {
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        sizeBytes: buffer.length,
        uploadToken,
      },
    });

    const remoteArtifactId = initRes.artifactId;
    const uploadUrl = initRes.uploadUrl || `/api/v1/uploads/${remoteArtifactId}/content`;

    await this.requestWithRetry({
      method: 'PUT',
      url: uploadUrl,
      headers: {
        'Content-Type': artifact.mimeType,
        'Content-Length': String(buffer.length),
        'x-content-sha256': sha256,
      },
      data: buffer,
    });

    return remoteArtifactId;
  }

  async submitAction(params: {
    businessId: string;
    action: string;
    input: Record<string, unknown>;
    artifacts: SubmissionArtifactRef[];
    documentSelection?: DocumentSelection;
    sourceUrl?: string;
    clientReference?: string;
    correlationId?: string;
    idempotencyKey: string;
  }): Promise<{ operationId: string; state: string; stateVersion: number }> {
    return this.requestWithRetry({
      method: 'POST',
      url: `/api/v1/businesses/${encodeURIComponent(params.businessId)}/actions/${encodeURIComponent(params.action)}`,
      headers: {
        'Idempotency-Key': params.idempotencyKey,
        ...(params.correlationId ? { 'x-correlation-id': params.correlationId } : {}),
        'Content-Type': 'application/json',
      },
      data: {
        input: params.input,
        ...(params.artifacts.length > 0 ? { artifacts: params.artifacts } : {}),
        ...(params.documentSelection ? { documentSelection: params.documentSelection } : {}),
        ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
        ...(params.clientReference ? { clientReference: params.clientReference } : {}),
      },
    });
  }

  async getOperation(remoteOperationId: string, waitSeconds?: number): Promise<OperationView> {
    return this.requestWithRetry({
      method: 'GET',
      url: `/api/v1/operations/${encodeURIComponent(remoteOperationId)}`,
      params: waitSeconds ? { wait: waitSeconds } : undefined,
    });
  }

  async cancelOperation(remoteOperationId: string): Promise<{ operationId: string; state: string }> {
    return this.requestWithRetry({
      method: 'POST',
      url: `/api/v1/operations/${encodeURIComponent(remoteOperationId)}/cancel`,
      headers: { 'Idempotency-Key': `cancel-${remoteOperationId}` },
    });
  }

  async resumeOperation(
    remoteOperationId: string,
    body: { waitId: string; expectedStateVersion: number; input: Record<string, unknown> },
  ): Promise<{ operationId: string; state: string; stateVersion: number }> {
    return this.requestWithRetry({
      method: 'POST',
      url: `/api/v1/operations/${encodeURIComponent(remoteOperationId)}/resume`,
      headers: {
        'Idempotency-Key': `resume-${remoteOperationId}-${body.expectedStateVersion}`,
        'Content-Type': 'application/json',
      },
      data: body,
    });
  }

  async fetchResultAndPayload(remoteOperationId: string): Promise<{
    envelope: ResultEnvelope;
    outputPayload: Record<string, unknown>;
  }> {
    const envelope = await this.requestWithRetry<ResultEnvelope>({
      method: 'GET',
      url: `/api/v1/operations/${encodeURIComponent(remoteOperationId)}/result`,
    });

    let outputPayload: Record<string, unknown> = envelope.data || {};
    const resultRef = typeof envelope.data?.resultRef === 'string' ? envelope.data.resultRef : undefined;
    if (resultRef && resultRef.startsWith('artifact://')) {
      const outputArtifactId = resultRef.slice('artifact://'.length);
      const downloaded = await this.requestWithRetry<unknown>({
        method: 'GET',
        url: `/api/v1/artifacts/${encodeURIComponent(outputArtifactId)}/download`,
      });
      if (isRecord(downloaded)) {
        outputPayload = downloaded;
      }
    }

    return { envelope, outputPayload };
  }

  async checkHealth(): Promise<{ ok: boolean; status?: string; detail?: unknown }> {
    try {
      const data = await this.requestWithRetry<Record<string, unknown>>({ method: 'GET', url: '/api/v1/health' }, 0);
      return { ok: true, status: String(data.status || 'healthy'), detail: data };
    } catch (err) {
      return { ok: false, status: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
