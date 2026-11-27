// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { isIP } from 'net';
import axios from 'axios';
import type { Application } from '@nocobase/server';
import type { Database } from '@nocobase/database';
import {
  createProblem,
  TERMINAL_OPERATION_STATES,
  type ArtifactEnvelopeItem,
  type DocumentInputCoverage,
  type DocumentInputPlan,
  type DocumentInputPlanItem,
  type DuOperationState,
  type OperationProgress,
  type OperationView,
  type PageSelectionSpec,
  type ProblemDetails,
  type ResultEnvelope,
  type SubmissionPayload,
  type UsageMetrics,
  type WaitState,
} from '../contracts/du-contracts';
import type { DuApiKeySummary, IssuedDuApiKey, ServiceConfig, UsageSummaryView } from '../types';
import { ArtifactStorageService, DuHttpError, type ArtifactRecord } from './ArtifactStorageService';
import { BuiltinBusinessEngine } from './BuiltinBusinessEngine';
import { ExternalDuReworkClient } from './ExternalDuReworkClient';

const OPERATIONS_COLLECTION = 'doc_understanding_operations';
const API_KEYS_COLLECTION = 'doc_understanding_api_keys';
const ARTIFACTS_COLLECTION = 'doc_understanding_artifacts';
const MAX_INLINE_WEBHOOK_RESULT_BYTES = 256 * 1024; // 256 KiB per BRD Section 4.4

export interface OperationRecord {
  id?: number;
  operationId: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  variant?: string | null;
  state: DuOperationState;
  stateVersion: number;
  correlationId?: string | null;
  clientReference?: string | null;
  idempotencyKey?: string | null;
  requestFingerprint?: string | null;
  submission: SubmissionPayload & { _checkpoint?: Record<string, unknown> };
  progress?: OperationProgress | null;
  waitState?: WaitState | null;
  documentInputPlan?: DocumentInputPlan | null;
  documentInputCoverage?: DocumentInputCoverage | null;
  resultEnvelope?: ResultEnvelope | null;
  outputPayload?: Record<string, unknown> | null;
  usage?: UsageMetrics | null;
  warnings?: string[] | null;
  errorProblem?: ProblemDetails | null;
  externalOperationId?: string | null;
  deadlineAt?: Date | string | null;
  completedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  ownedBy?: string | null;
  leaseExpiresAt?: Date | string | null;
  createdById?: number | null;
}

export interface ApiKeyAuthPrincipal {
  kind: 'du_api_key' | 'nocobase_user';
  tenantId: string;
  userId?: number;
  apiKeyId?: number;
  allowedBusinesses: string[];
  allowedActions: string[];
  requestDefaults?: Record<string, unknown> | null;
  lockedFields?: string[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPlain<T>(row: unknown): T {
  if (row && typeof row === 'object' && typeof (row as { toJSON?: () => T }).toJSON === 'function') {
    return (row as { toJSON: () => T }).toJSON();
  }
  return row as T;
}

function sha256String(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal')) {
    return true;
  }
  const ipVer = isIP(lower);
  if (ipVer === 4) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  } else if (ipVer === 6) {
    if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

function assertSafeOutboundCallbackUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DuHttpError(
      createProblem(422, 'INVALID_SCHEMA', 'Invalid callback.url', {
        errors: [{ pointer: '/callback/url', message: 'Must be a valid HTTP(S) URL' }],
      }),
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'callback.url must use https:// or http://'));
  }
  if (parsed.username || parsed.password) {
    throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'callback.url must not embed credentials'));
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new DuHttpError(
      createProblem(422, 'INVALID_SCHEMA', 'callback.url target host is blocked by egress SSRF policy'),
    );
  }
  return parsed.toString();
}

function resolveBusinessVersion(businessId: string): string {
  if (businessId === 'document-core') return '2.0.0';
  if (businessId === 'lc-checker') return '1.2.0';
  if (businessId === 'example-review') return '1.0.0';
  throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Business "${businessId}" is not registered`));
}

function resolveVariantFromInput(action: string, input: Record<string, unknown>): string | undefined {
  if (action === 'ingest' || action === 'compare') return typeof input.mode === 'string' ? input.mode : undefined;
  if (action === 'extract') return typeof input.type === 'string' ? input.type : undefined;
  if (action === 'analyze' || action === 'generate') return typeof input.task === 'string' ? input.task : undefined;
  if (action === 'transform') {
    return typeof input.variant === 'string'
      ? input.variant
      : typeof input.action === 'string'
        ? input.action
        : undefined;
  }
  return undefined;
}

export class OperationOrchestrator {
  private readonly app: Application;
  private readonly db: Database;
  public readonly artifactStorage: ArtifactStorageService;
  public readonly builtinEngine: BuiltinBusinessEngine;
  private readonly getConfig: () => Promise<ServiceConfig>;
  private readonly nodeId: string;
  private readonly stateEvents = new EventEmitter();

  constructor(params: {
    app: Application;
    db: Database;
    artifactStorage: ArtifactStorageService;
    builtinEngine: BuiltinBusinessEngine;
    getConfig: () => Promise<ServiceConfig>;
    nodeId: string;
  }) {
    this.app = params.app;
    this.db = params.db;
    this.artifactStorage = params.artifactStorage;
    this.builtinEngine = params.builtinEngine;
    this.getConfig = params.getConfig;
    this.nodeId = params.nodeId;
    this.stateEvents.setMaxListeners(200);
  }

  /* ─── Gateway API Key Management (Profile-scoped, SHA-256 hashed) ─── */

  async issueApiKey(params: {
    name: string;
    tenantId?: string;
    allowedBusinesses?: string[];
    allowedActions?: string[];
    requestDefaults?: Record<string, unknown> | null;
    lockedFields?: string[] | null;
    expiresAt?: string | Date | null;
    userId?: number;
  }): Promise<IssuedDuApiKey> {
    if (!params.name || !params.name.trim()) {
      throw new DuHttpError(createProblem(422, 'INVALID_SCHEMA', 'API key name is required'));
    }
    const rawRandom = crypto.randomBytes(24).toString('hex');
    const rawKey = `du_live_${rawRandom}`;
    const keyPrefix = rawKey.slice(0, 16);
    const keyHash = sha256String(rawKey);
    const tenantId = (params.tenantId || 'default').trim() || 'default';
    const allowedBusinesses =
      Array.isArray(params.allowedBusinesses) && params.allowedBusinesses.length > 0
        ? params.allowedBusinesses.map(String)
        : ['*'];
    const allowedActions =
      Array.isArray(params.allowedActions) && params.allowedActions.length > 0
        ? params.allowedActions.map(String)
        : ['*'];

    const created = await this.db.getRepository(API_KEYS_COLLECTION).create({
      values: {
        name: params.name.trim(),
        keyPrefix,
        keyHash,
        tenantId,
        allowedBusinesses,
        allowedActions,
        requestDefaults: params.requestDefaults ?? null,
        lockedFields: params.lockedFields ?? null,
        status: 'active',
        expiresAt: params.expiresAt ?? null,
        createdById: params.userId ?? null,
      },
    });
    const record = toPlain<DuApiKeySummary & { id: number }>(created);
    return {
      id: record.id,
      name: record.name,
      keyPrefix,
      tenantId,
      allowedBusinesses,
      allowedActions,
      requestDefaults: record.requestDefaults ?? null,
      lockedFields: record.lockedFields ?? null,
      status: 'active',
      expiresAt: record.expiresAt ?? null,
      lastUsedAt: null,
      createdAt: record.createdAt,
      rawKey,
    };
  }

  async listApiKeys(): Promise<DuApiKeySummary[]> {
    const rows = await this.db.getRepository(API_KEYS_COLLECTION).find({
      sort: ['-createdAt'],
    });
    return rows.map((row: unknown) => {
      const plain = toPlain<DuApiKeySummary & { keyHash?: string }>(row);
      const { keyHash: _omitted, ...safe } = plain;
      return safe;
    });
  }

  async revokeApiKey(id: number): Promise<void> {
    await this.db.getRepository(API_KEYS_COLLECTION).update({
      filterByTk: id,
      values: { status: 'revoked' },
    });
  }

  async authenticateRawApiKey(rawKey: string): Promise<ApiKeyAuthPrincipal> {
    const trimmed = rawKey.trim();
    if (!trimmed) {
      throw new DuHttpError(createProblem(401, 'UNAUTHENTICATED', 'Missing x-api-key header'));
    }
    const keyHash = sha256String(trimmed);
    const repo = this.db.getRepository(API_KEYS_COLLECTION);
    const row = await repo.findOne({ filter: { keyHash } });
    if (!row) {
      throw new DuHttpError(createProblem(401, 'UNAUTHENTICATED', 'Invalid API key'));
    }
    const record = toPlain<{
      id: number;
      tenantId: string;
      status: string;
      expiresAt?: string | Date | null;
      allowedBusinesses?: string[];
      allowedActions?: string[];
      requestDefaults?: Record<string, unknown> | null;
      lockedFields?: string[] | null;
      createdById?: number | null;
    }>(row);

    if (record.status !== 'active') {
      throw new DuHttpError(createProblem(401, 'UNAUTHENTICATED', 'API key has been revoked'));
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new DuHttpError(createProblem(401, 'UNAUTHENTICATED', 'API key has expired'));
    }

    try {
      await repo.update({
        filterByTk: record.id,
        values: { lastUsedAt: new Date() },
      });
    } catch {
      // Non-fatal metadata update
    }

    return {
      kind: 'du_api_key',
      apiKeyId: record.id,
      tenantId: record.tenantId || 'default',
      userId: record.createdById ?? undefined,
      allowedBusinesses: Array.isArray(record.allowedBusinesses) ? record.allowedBusinesses : ['*'],
      allowedActions: Array.isArray(record.allowedActions) ? record.allowedActions : ['*'],
      requestDefaults: record.requestDefaults ?? null,
      lockedFields: record.lockedFields ?? null,
    };
  }

  private assertActionPermitted(principal: ApiKeyAuthPrincipal, businessId: string, action: string): void {
    const bizOk = principal.allowedBusinesses.includes('*') || principal.allowedBusinesses.includes(businessId);
    const actOk =
      principal.allowedActions.includes('*') ||
      principal.allowedActions.includes(action) ||
      principal.allowedActions.includes(`${businessId}:${action}`);
    if (!bizOk || !actOk) {
      throw new DuHttpError(
        createProblem(
          403,
          'PERMISSION_DENIED',
          `API key profile does not grant permission for ${businessId}/${action}`,
        ),
      );
    }
  }

  private applyProfilePolicyToInput(
    principal: ApiKeyAuthPrincipal,
    callerInput: Record<string, unknown>,
  ): Record<string, unknown> {
    const defaults = isRecord(principal.requestDefaults) ? principal.requestDefaults : {};
    const locked = Array.isArray(principal.lockedFields) ? principal.lockedFields : [];

    for (const lockedKey of locked) {
      if (
        Object.prototype.hasOwnProperty.call(callerInput, lockedKey) &&
        Object.prototype.hasOwnProperty.call(defaults, lockedKey) &&
        JSON.stringify(callerInput[lockedKey]) !== JSON.stringify(defaults[lockedKey])
      ) {
        throw new DuHttpError(
          createProblem(403, 'PERMISSION_DENIED', `Parameter "${lockedKey}" is locked by profile policy`),
        );
      }
    }

    return {
      ...defaults,
      ...callerInput,
    };
  }

  /* ─── Canonical Operation Submission & Execution ─────────────────── */

  async submitOperation(params: {
    principal: ApiKeyAuthPrincipal;
    businessId: string;
    action: string;
    submission: SubmissionPayload;
    idempotencyKey?: string;
    correlationId?: string;
    urlPrefix?: string;
    waitCompletionMs?: number;
  }): Promise<{
    httpStatus: 200 | 202;
    operationId: string;
    state: DuOperationState;
    stateVersion: number;
    replayed: boolean;
    correlationId: string;
    links: { self: string; result: string };
  }> {
    const { principal, businessId, action, submission, idempotencyKey, urlPrefix = '/api/du/v1' } = params;
    const businessVersion = resolveBusinessVersion(businessId);
    this.assertActionPermitted(principal, businessId, action);

    if (!isRecord(submission) || !isRecord(submission.input)) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', 'Request body must include an "input" object', {
          errors: [{ pointer: '/input', message: 'Expected object' }],
        }),
      );
    }

    if (submission.callback?.url) {
      assertSafeOutboundCallbackUrl(submission.callback.url);
    }

    const effectiveInput = this.applyProfilePolicyToInput(principal, submission.input);
    const correlationId = (params.correlationId || crypto.randomUUID()).trim();
    const fingerprint = sha256String(
      JSON.stringify({
        businessId,
        action,
        input: effectiveInput,
        artifacts: submission.artifacts || [],
        documentSelection: submission.documentSelection || null,
        sourceUrl: submission.sourceUrl || null,
      }),
    );

    const opsRepo = this.db.getRepository(OPERATIONS_COLLECTION);
    if (idempotencyKey && idempotencyKey.trim()) {
      const existingRow = await opsRepo.findOne({
        filter: { tenantId: principal.tenantId, idempotencyKey: idempotencyKey.trim() },
      });
      if (existingRow) {
        const existing = toPlain<OperationRecord>(existingRow);
        if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
          throw new DuHttpError(
            createProblem(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key was already used with a different request payload',
              { correlationId },
            ),
          );
        }
        return {
          httpStatus: 200,
          operationId: existing.operationId,
          state: existing.state,
          stateVersion: existing.stateVersion,
          replayed: true,
          correlationId: existing.correlationId || correlationId,
          links: {
            self: `${urlPrefix}/operations/${existing.operationId}`,
            result: `${urlPrefix}/operations/${existing.operationId}/result`,
          },
        };
      }
    }

    const config = await this.getConfig();
    const maxFiles = config.maxFilesPerRequest ?? 20;
    const maxBytes = config.maxFileSizeBytes ?? 10 * 1024 * 1024;
    const artifactRefs = Array.isArray(submission.artifacts) ? submission.artifacts : [];

    if (artifactRefs.length > maxFiles) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', `Too many input artifacts (${artifactRefs.length} > max ${maxFiles})`, {
          correlationId,
        }),
      );
    }

    // Validate all input artifacts belong to tenant & are READY, and build DI-06 DocumentInputPlan
    const resolvedArtifacts: ArtifactRecord[] = [];
    for (const ref of artifactRefs) {
      if (!ref || typeof ref.artifactId !== 'string') {
        throw new DuHttpError(
          createProblem(422, 'INVALID_SCHEMA', 'Each artifact reference must specify artifactId', { correlationId }),
        );
      }
      const record = await this.artifactStorage.getArtifactOrThrow(principal.tenantId, ref.artifactId);
      if (record.state !== 'READY') {
        throw new DuHttpError(
          createProblem(409, 'STATE_CONFLICT', `Artifact ${ref.artifactId} is not READY (state=${record.state})`, {
            correlationId,
          }),
        );
      }
      if (record.sizeBytes > maxBytes) {
        throw new DuHttpError(
          createProblem(
            413,
            'PAYLOAD_TOO_LARGE',
            `Artifact ${ref.artifactId} (${record.sizeBytes} bytes) exceeds documentInput policy limit (${maxBytes} bytes)`,
            { correlationId },
          ),
        );
      }
      resolvedArtifacts.push(record);
    }

    const documentInputPlan = this.buildDocumentInputPlan(resolvedArtifacts, submission);
    const operationId = crypto.randomUUID();
    const deadlineMs = config.pollTimeout || 300_000;
    const deadlineAt = new Date(Date.now() + deadlineMs);

    await opsRepo.create({
      values: {
        operationId,
        tenantId: principal.tenantId,
        businessId,
        businessVersion,
        action,
        variant: resolveVariantFromInput(action, effectiveInput) ?? null,
        state: 'ACCEPTED',
        stateVersion: 1,
        correlationId,
        clientReference: submission.clientReference ?? null,
        idempotencyKey: idempotencyKey?.trim() || null,
        requestFingerprint: fingerprint,
        submission: {
          ...submission,
          input: effectiveInput,
        },
        progress: { percent: 0, message: 'ACCEPTED' },
        documentInputPlan,
        deadlineAt,
        ownedBy: this.nodeId,
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        createdById: principal.userId ?? null,
      },
    });

    // Attach operationId to input artifacts that don't have one yet
    if (resolvedArtifacts.length > 0) {
      await this.db.getRepository(ARTIFACTS_COLLECTION).update({
        filter: {
          tenantId: principal.tenantId,
          artifactId: { $in: resolvedArtifacts.map((a) => a.artifactId) },
          operationId: null,
        },
        values: { operationId },
      });
    }

    const executionPromise = this.runOperationInBackground(operationId, resolvedArtifacts, urlPrefix);
    executionPromise.catch((err) => {
      this.app.logger?.error?.(`Document Understanding operation ${operationId} background failure`, err);
    });

    if (params.waitCompletionMs && params.waitCompletionMs > 0) {
      await this.waitForOperation(
        principal.tenantId,
        operationId,
        Math.ceil(params.waitCompletionMs / 1000),
        urlPrefix,
      );
      const latest = await this.getOperationRecordOrThrow(principal.tenantId, operationId);
      return {
        httpStatus: 202,
        operationId,
        state: latest.state,
        stateVersion: latest.stateVersion,
        replayed: false,
        correlationId,
        links: {
          self: `${urlPrefix}/operations/${operationId}`,
          result: `${urlPrefix}/operations/${operationId}/result`,
        },
      };
    }

    return {
      httpStatus: 202,
      operationId,
      state: 'ACCEPTED',
      stateVersion: 1,
      replayed: false,
      correlationId,
      links: {
        self: `${urlPrefix}/operations/${operationId}`,
        result: `${urlPrefix}/operations/${operationId}/result`,
      },
    };
  }

  private buildDocumentInputPlan(artifacts: ArtifactRecord[], submission: SubmissionPayload): DocumentInputPlan {
    const sel = submission.documentSelection;
    let selectedArtifacts = artifacts;
    if (sel?.artifactIds && sel.artifactIds.length > 0) {
      const allowedSet = new Set(sel.artifactIds);
      selectedArtifacts = artifacts.filter((a) => allowedSet.has(a.artifactId));
    }

    const items: DocumentInputPlanItem[] = selectedArtifacts.map((artifact) => {
      const explicitPageSel = sel?.pageSelections?.find((p) => p.artifactId === artifact.artifactId);
      const selection: PageSelectionSpec = explicitPageSel ? explicitPageSel.selection : { kind: 'all' };
      return {
        artifactId: artifact.artifactId,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        selection,
      };
    });

    return {
      kind: 'documentInputPlan',
      schemaVersion: 1,
      items,
    };
  }

  private async runOperationInBackground(
    operationId: string,
    preloadedArtifacts?: ArtifactRecord[],
    urlPrefix = '/api/du/v1',
    resumedInput?: Record<string, unknown>,
  ): Promise<void> {
    const opsRepo = this.db.getRepository(OPERATIONS_COLLECTION);
    const row = await opsRepo.findOne({ filter: { operationId } });
    if (!row) return;
    const op = toPlain<OperationRecord>(row);

    if (TERMINAL_OPERATION_STATES.has(op.state)) return;
    if (op.state === 'CANCEL_REQUESTED') {
      await this.transitionOperation(operationId, {
        state: 'CANCELLED',
        progress: { percent: 100, message: 'CANCELLED' },
        completedAt: new Date(),
      });
      return;
    }

    await this.transitionOperation(operationId, {
      state: 'RUNNING',
      progress: { percent: 10, message: 'RUNNING' },
      ownedBy: this.nodeId,
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const config = await this.getConfig();
    const artifacts =
      preloadedArtifacts ??
      (await Promise.all(
        (op.submission.artifacts || []).map((ref) =>
          this.artifactStorage.getArtifactOrThrow(op.tenantId, ref.artifactId),
        ),
      ));

    try {
      const shouldUseExternalGateway =
        config.engineMode === 'du_rework' ||
        (config.engineMode === 'hybrid' &&
          !this.builtinEngine.resolveAiManager() &&
          Boolean(config.baseUrl) &&
          config.baseUrl !== 'http://localhost:8000');

      if (shouldUseExternalGateway) {
        await this.executeViaExternalGateway(op, artifacts, config, urlPrefix, resumedInput);
        return;
      }

      const planItems = op.documentInputPlan?.items || [];
      const outcome = await this.builtinEngine.execute({
        operationId,
        tenantId: op.tenantId,
        businessId: op.businessId,
        action: op.action,
        input: op.submission.input,
        artifacts,
        planItems,
        config,
        resumedInput,
        checkpointData: op.submission._checkpoint,
        userId: op.createdById ?? undefined,
        onProgress: async (percent, message) => {
          await opsRepo.update({
            filter: { operationId },
            values: { progress: { percent, message } },
          });
        },
      });

      // Re-read to check if cancel was requested mid-flight
      const refreshedRow = await opsRepo.findOne({ filter: { operationId } });
      const refreshed = refreshedRow ? toPlain<OperationRecord>(refreshedRow) : op;
      if (refreshed.state === 'CANCEL_REQUESTED') {
        await this.transitionOperation(operationId, {
          state: 'CANCELLED',
          progress: { percent: 100, message: 'CANCELLED' },
          completedAt: new Date(),
        });
        await this.dispatchCallbackIfConfigured(operationId, urlPrefix);
        return;
      }

      if (outcome.kind === 'waiting_input') {
        await this.transitionOperation(operationId, {
          state: 'WAITING_INPUT',
          progress: { percent: 50, message: 'WAITING_INPUT' },
          waitState: outcome.waitState,
          usage: outcome.usage,
          submission: {
            ...op.submission,
            _checkpoint: outcome.checkpointData,
          },
          leaseExpiresAt: null,
        });
        await this.dispatchCallbackIfConfigured(operationId, urlPrefix);
        return;
      }

      const outputArtifact = await this.artifactStorage.createJsonOutputArtifact({
        tenantId: op.tenantId,
        operationId,
        payload: outcome.outputPayload,
        userId: op.createdById ?? undefined,
      });

      const planDigest = `sha256:${sha256String(JSON.stringify(op.documentInputPlan || {}))}`;
      const coverageOutcomes = outcome.coverageOutcomes.map((item) => ({
        ...item,
        outputRefs: item.outputRefs.length > 0 ? item.outputRefs : [outputArtifact.artifactId],
      }));
      const coverageStatus = coverageOutcomes.some((c) => c.status === 'failed') ? 'failed' : 'complete';
      const documentInputCoverage: DocumentInputCoverage = {
        kind: 'coverageReport',
        schemaVersion: 1,
        planDigest,
        status: coverageStatus,
        outcomes: coverageOutcomes,
      };

      // DI-06 strict invariant: partial coverage failure fails the operation
      if (coverageStatus === 'failed') {
        throw new DuHttpError(
          createProblem(422, 'INCOMPLETE_DOCUMENT_COVERAGE', 'One or more selected document pages failed processing'),
        );
      }

      const envelopeArtifacts: ArtifactEnvelopeItem[] = [
        ...artifacts.map((a) => ({
          artifactId: a.artifactId,
          role: a.role,
          fileName: a.fileName,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          hashSha256: a.hashSha256 || '',
          download: `${urlPrefix}/artifacts/${a.artifactId}/download`,
        })),
        {
          artifactId: outputArtifact.artifactId,
          role: 'output',
          fileName: outputArtifact.fileName,
          mimeType: outputArtifact.mimeType,
          sizeBytes: outputArtifact.sizeBytes,
          hashSha256: outputArtifact.hashSha256 || '',
          download: `${urlPrefix}/artifacts/${outputArtifact.artifactId}/download`,
        },
        ...outcome.extraOutputArtifacts.map((extra) => ({
          artifactId: extra.artifactId,
          role: 'output' as const,
          fileName: extra.fileName,
          mimeType: extra.mimeType,
          sizeBytes: extra.sizeBytes,
          hashSha256: extra.hashSha256 || '',
          download: `${urlPrefix}/artifacts/${extra.artifactId}/download`,
        })),
      ];

      const resultEnvelope: ResultEnvelope = {
        schemaVersion: '1',
        data: {
          resultRef: `artifact://${outputArtifact.artifactId}`,
        },
        artifacts: envelopeArtifacts,
        usage: outcome.usage,
        warnings: outcome.warnings,
      };

      await this.transitionOperation(operationId, {
        state: 'SUCCEEDED',
        progress: { percent: 100, message: 'SUCCEEDED' },
        documentInputCoverage,
        resultEnvelope,
        outputPayload: outcome.outputPayload,
        usage: outcome.usage,
        warnings: outcome.warnings,
        waitState: null,
        completedAt: new Date(),
        leaseExpiresAt: null,
      });

      await this.dispatchCallbackIfConfigured(operationId, urlPrefix);
    } catch (err: unknown) {
      const problem =
        err instanceof DuHttpError
          ? err.problem
          : createProblem(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err), {
              correlationId: op.correlationId ?? undefined,
            });
      await this.transitionOperation(operationId, {
        state: 'FAILED',
        progress: { percent: 100, message: problem.title },
        errorProblem: problem,
        completedAt: new Date(),
        leaseExpiresAt: null,
      });
      await this.dispatchCallbackIfConfigured(operationId, urlPrefix);
    }
  }

  private async executeViaExternalGateway(
    op: OperationRecord,
    artifacts: ArtifactRecord[],
    config: ServiceConfig,
    urlPrefix: string,
    resumedInput?: Record<string, unknown>,
  ): Promise<void> {
    const client = new ExternalDuReworkClient(config);
    let remoteOpId = op.externalOperationId || undefined;

    if (!remoteOpId) {
      const remoteRefs = [];
      for (const art of artifacts) {
        const buf = this.artifactStorage.readArtifactBuffer(art);
        const remoteArtId = await client.uploadArtifact(art, buf);
        remoteRefs.push({ artifactId: remoteArtId, role: art.role });
      }
      const submitted = await client.submitAction({
        businessId: op.businessId,
        action: op.action,
        input: op.submission.input,
        artifacts: remoteRefs,
        documentSelection: op.submission.documentSelection,
        sourceUrl: op.submission.sourceUrl,
        clientReference: op.clientReference ?? undefined,
        correlationId: op.correlationId ?? undefined,
        idempotencyKey: `proxy-${op.operationId}`,
      });
      remoteOpId = submitted.operationId;
      await this.db.getRepository(OPERATIONS_COLLECTION).update({
        filter: { operationId: op.operationId },
        values: { externalOperationId: remoteOpId },
      });
    } else if (resumedInput && op.waitState) {
      await client.resumeOperation(remoteOpId, {
        waitId: op.waitState.waitId,
        expectedStateVersion: op.stateVersion,
        input: resumedInput,
      });
    }

    const startTime = Date.now();
    const timeoutMs = config.pollTimeout || 300_000;
    const pollIntervalMs = config.pollInterval || 3_000;

    while (Date.now() - startTime < timeoutMs) {
      const remoteView = await client.getOperation(remoteOpId);
      if (remoteView.state === 'WAITING_INPUT') {
        await this.transitionOperation(op.operationId, {
          state: 'WAITING_INPUT',
          progress: remoteView.progress || { percent: 50, message: 'WAITING_INPUT' },
          waitState: remoteView.wait || { waitId: 'external-wait' },
          leaseExpiresAt: null,
        });
        await this.dispatchCallbackIfConfigured(op.operationId, urlPrefix);
        return;
      }
      if (remoteView.state === 'SUCCEEDED') {
        const { envelope, outputPayload } = await client.fetchResultAndPayload(remoteOpId);
        const localOutputArtifact = await this.artifactStorage.createJsonOutputArtifact({
          tenantId: op.tenantId,
          operationId: op.operationId,
          payload: outputPayload,
          userId: op.createdById ?? undefined,
        });
        const localEnvelope: ResultEnvelope = {
          schemaVersion: '1',
          data: { resultRef: `artifact://${localOutputArtifact.artifactId}` },
          artifacts: [
            {
              artifactId: localOutputArtifact.artifactId,
              role: 'output',
              fileName: localOutputArtifact.fileName,
              mimeType: localOutputArtifact.mimeType,
              sizeBytes: localOutputArtifact.sizeBytes,
              hashSha256: localOutputArtifact.hashSha256 || '',
              download: `${urlPrefix}/artifacts/${localOutputArtifact.artifactId}/download`,
            },
          ],
          usage: envelope.usage,
          warnings: envelope.warnings || [],
        };
        await this.transitionOperation(op.operationId, {
          state: 'SUCCEEDED',
          progress: { percent: 100, message: 'SUCCEEDED' },
          documentInputCoverage: remoteView.documentInputCoverage ?? null,
          resultEnvelope: localEnvelope,
          outputPayload,
          usage: envelope.usage,
          warnings: envelope.warnings || [],
          completedAt: new Date(),
          leaseExpiresAt: null,
        });
        await this.dispatchCallbackIfConfigured(op.operationId, urlPrefix);
        return;
      }
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(remoteView.state)) {
        await this.transitionOperation(op.operationId, {
          state: remoteView.state,
          progress: { percent: 100, message: remoteView.state },
          errorProblem:
            remoteView.error || createProblem(500, remoteView.state, `Remote operation ended as ${remoteView.state}`),
          completedAt: new Date(),
          leaseExpiresAt: null,
        });
        await this.dispatchCallbackIfConfigured(op.operationId, urlPrefix);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    await this.transitionOperation(op.operationId, {
      state: 'TIMED_OUT',
      progress: { percent: 100, message: 'TIMED_OUT' },
      errorProblem: createProblem(504, 'TIMED_OUT', 'External gateway polling timed out'),
      completedAt: new Date(),
      leaseExpiresAt: null,
    });
  }

  private async transitionOperation(operationId: string, patch: Partial<OperationRecord>): Promise<void> {
    const repo = this.db.getRepository(OPERATIONS_COLLECTION);
    const currentRow = await repo.findOne({ filter: { operationId } });
    if (!currentRow) return;
    const current = toPlain<OperationRecord>(currentRow);
    const nextVersion = (current.stateVersion || 1) + 1;

    await repo.update({
      filter: { operationId },
      values: {
        ...patch,
        stateVersion: nextVersion,
      },
    });

    this.stateEvents.emit(`op:${operationId}`, patch.state || current.state);
  }

  private async dispatchCallbackIfConfigured(operationId: string, urlPrefix: string): Promise<void> {
    const row = await this.db.getRepository(OPERATIONS_COLLECTION).findOne({ filter: { operationId } });
    if (!row) return;
    const op = toPlain<OperationRecord>(row);
    const callbackUrl = op.submission?.callback?.url;
    if (!callbackUrl) return;

    try {
      const safeUrl = assertSafeOutboundCallbackUrl(callbackUrl);
      const config = await this.getConfig();
      const deliveryId = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const mode = op.submission.callback?.mode || 'notification_only';

      const payload: Record<string, unknown> = {
        deliveryId,
        operationId: op.operationId,
        state: op.state,
        stateVersion: op.stateVersion,
        businessId: op.businessId,
        action: op.action,
        correlationId: op.correlationId,
        clientReference: op.clientReference,
        ...(op.state === 'WAITING_INPUT' && op.waitState ? { wait: op.waitState } : {}),
        links: {
          self: `${urlPrefix}/operations/${op.operationId}`,
          result: `${urlPrefix}/operations/${op.operationId}/result`,
        },
      };

      if (mode === 'notification_with_result' && op.state === 'SUCCEEDED' && op.outputPayload) {
        const serializedResult = JSON.stringify(op.outputPayload);
        if (Buffer.byteLength(serializedResult, 'utf8') <= MAX_INLINE_WEBHOOK_RESULT_BYTES) {
          payload.result = op.outputPayload;
          payload.usage = op.usage;
        } else {
          payload.resultTruncatedToLink = true;
        }
      }

      const rawBody = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-du-delivery-id': deliveryId,
        'x-du-timestamp': timestamp,
      };
      if (config.webhookSecret) {
        const hmac = crypto.createHmac('sha256', config.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
        headers['x-du-signature'] = `sha256=${hmac}`;
      }

      await axios.post(safeUrl, rawBody, {
        headers,
        timeout: 10_000,
        maxRedirects: 0, // CALLBACK_REDIRECTS_ALLOWED = false per BRD Section 4.4
      });
    } catch (err) {
      this.app.logger?.warn?.(`Outbound webhook delivery failed for operation ${operationId}`, err);
    }
  }

  /* ─── Query, Wait, Resume, Cancel, Result & Usage APIs ──────────── */

  async getOperationRecordOrThrow(tenantId: string, operationId: string): Promise<OperationRecord> {
    const filter = tenantId === '*' ? { operationId } : { tenantId, operationId };
    const row = await this.db.getRepository(OPERATIONS_COLLECTION).findOne({ filter });
    if (!row) {
      // Fail-closed 404 prevents cross-tenant ID enumeration per BRD Section 1.3
      throw new DuHttpError(createProblem(404, 'NOT_FOUND', `Operation ${operationId} not found`));
    }
    return toPlain<OperationRecord>(row);
  }

  toOperationView(op: OperationRecord, urlPrefix = '/api/du/v1'): OperationView {
    return {
      id: op.operationId,
      name: `operations/${op.operationId}`,
      businessId: op.businessId,
      businessVersion: op.businessVersion,
      action: op.action,
      state: op.state,
      stateVersion: op.stateVersion,
      ...(op.correlationId ? { correlationId: op.correlationId } : {}),
      ...(op.clientReference ? { clientReference: op.clientReference } : {}),
      createdAt: op.createdAt ? new Date(op.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: op.updatedAt ? new Date(op.updatedAt).toISOString() : new Date().toISOString(),
      ...(op.deadlineAt ? { deadlineAt: new Date(op.deadlineAt).toISOString() } : {}),
      progress: op.progress || { percent: 0, message: op.state },
      ...(op.state === 'WAITING_INPUT' && op.waitState ? { wait: op.waitState } : {}),
      ...(op.documentInputCoverage ? { documentInputCoverage: op.documentInputCoverage } : {}),
      ...(op.usage ? { usage: op.usage } : {}),
      ...(op.errorProblem ? { error: op.errorProblem } : {}),
      links: {
        self: `${urlPrefix}/operations/${op.operationId}`,
        result: `${urlPrefix}/operations/${op.operationId}/result`,
      },
    };
  }

  async waitForOperation(
    tenantId: string,
    operationId: string,
    waitSeconds = 0,
    urlPrefix = '/api/du/v1',
  ): Promise<OperationView> {
    const boundedSeconds = Math.max(0, Math.min(30, Number(waitSeconds) || 0));
    const initial = await this.getOperationRecordOrThrow(tenantId, operationId);
    if (boundedSeconds === 0 || TERMINAL_OPERATION_STATES.has(initial.state) || initial.state === 'WAITING_INPUT') {
      return this.toOperationView(initial, urlPrefix);
    }

    await new Promise<void>((resolve) => {
      const channel = `op:${operationId}`;
      const timer = setTimeout(() => {
        this.stateEvents.removeListener(channel, onState);
        resolve();
      }, boundedSeconds * 1000);

      function onState(nextState: DuOperationState) {
        if (TERMINAL_OPERATION_STATES.has(nextState) || nextState === 'WAITING_INPUT') {
          clearTimeout(timer);
          resolve();
        }
      }

      this.stateEvents.on(channel, onState);
    });

    const latest = await this.getOperationRecordOrThrow(tenantId, operationId);
    return this.toOperationView(latest, urlPrefix);
  }

  async listOperations(params: {
    tenantId: string;
    state?: string;
    businessId?: string;
    action?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
    urlPrefix?: string;
  }): Promise<{ items: OperationView[]; nextCursor: string | null }> {
    const filter: Record<string, unknown> = {};
    if (params.tenantId !== '*') filter.tenantId = params.tenantId;
    if (params.state) filter.state = params.state;
    if (params.businessId) filter.businessId = params.businessId;
    if (params.action) filter.action = params.action;
    if (params.from || params.to) {
      const createdFilter: Record<string, unknown> = {};
      if (params.from) createdFilter.$gte = new Date(params.from);
      if (params.to) createdFilter.$lt = new Date(params.to);
      filter.createdAt = createdFilter;
    }
    if (params.cursor && Number.isFinite(Number(params.cursor))) {
      filter.id = { $lt: Number(params.cursor) };
    }

    const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
    const rows = await this.db.getRepository(OPERATIONS_COLLECTION).find({
      filter,
      sort: ['-id'],
      limit: limit + 1,
    });

    const plains = rows.map((r: unknown) => toPlain<OperationRecord>(r));
    const hasMore = plains.length > limit;
    const slice = hasMore ? plains.slice(0, limit) : plains;
    const lastId = slice.length > 0 ? slice[slice.length - 1].id : undefined;

    return {
      items: slice.map((op: OperationRecord) => this.toOperationView(op, params.urlPrefix || '/api/du/v1')),
      nextCursor: hasMore && lastId != null ? String(lastId) : null,
    };
  }

  async cancelOperation(
    tenantId: string,
    operationId: string,
  ): Promise<{
    httpStatus: 200 | 202;
    operationId: string;
    state: DuOperationState;
    stateVersion: number;
    replayed: boolean;
  }> {
    const op = await this.getOperationRecordOrThrow(tenantId, operationId);
    if (op.state === 'CANCELLED' || op.state === 'CANCEL_REQUESTED') {
      return {
        httpStatus: 200,
        operationId,
        state: op.state,
        stateVersion: op.stateVersion,
        replayed: true,
      };
    }
    if (TERMINAL_OPERATION_STATES.has(op.state)) {
      throw new DuHttpError(
        createProblem(409, 'STATE_CONFLICT', `Cannot cancel terminal operation in state ${op.state}`),
      );
    }

    if (op.externalOperationId) {
      const config = await this.getConfig();
      const ext = new ExternalDuReworkClient(config);
      ext.cancelOperation(op.externalOperationId).catch(() => undefined);
    }

    const nextState: DuOperationState =
      op.state === 'WAITING_INPUT' || op.state === 'ACCEPTED' || op.state === 'QUEUED'
        ? 'CANCELLED'
        : 'CANCEL_REQUESTED';

    await this.transitionOperation(operationId, {
      state: nextState,
      progress: { percent: 100, message: nextState },
      ...(nextState === 'CANCELLED' ? { completedAt: new Date(), leaseExpiresAt: null } : {}),
    });

    const updated = await this.getOperationRecordOrThrow(tenantId, operationId);
    return {
      httpStatus: 202,
      operationId,
      state: updated.state,
      stateVersion: updated.stateVersion,
      replayed: false,
    };
  }

  async resumeOperation(params: {
    tenantId: string;
    operationId: string;
    waitId?: string;
    expectedStateVersion?: number;
    input: Record<string, unknown>;
    resumedBy?: string;
    urlPrefix?: string;
  }): Promise<{
    httpStatus: 202;
    operationId: string;
    state: DuOperationState;
    stateVersion: number;
    replayed: false;
  }> {
    const op = await this.getOperationRecordOrThrow(params.tenantId, params.operationId);
    if (op.state !== 'WAITING_INPUT' || !op.waitState) {
      throw new DuHttpError(
        createProblem(
          409,
          'STATE_CONFLICT',
          `Operation ${params.operationId} is in state ${op.state}, expected WAITING_INPUT`,
        ),
      );
    }
    if (params.waitId && params.waitId !== op.waitState.waitId) {
      throw new DuHttpError(
        createProblem(
          409,
          'STATE_CONFLICT',
          `waitId mismatch (expected "${op.waitState.waitId}", got "${params.waitId}")`,
        ),
      );
    }
    if (params.expectedStateVersion !== undefined && Number(params.expectedStateVersion) !== Number(op.stateVersion)) {
      throw new DuHttpError(
        createProblem(
          409,
          'STATE_CONFLICT',
          `expectedStateVersion mismatch (expected ${op.stateVersion}, got ${params.expectedStateVersion})`,
        ),
      );
    }

    const enrichedInput = {
      ...params.input,
      ...(params.resumedBy && !params.input.approver ? { approver: params.resumedBy } : {}),
    };

    await this.transitionOperation(params.operationId, {
      state: 'QUEUED',
      progress: { percent: 60, message: 'RESUMED' },
      waitState: {
        ...op.waitState,
        resumedAt: new Date().toISOString(),
        resumedBy: params.resumedBy,
        resumedInput: enrichedInput,
      },
    });

    const refreshed = await this.getOperationRecordOrThrow(params.tenantId, params.operationId);
    this.runOperationInBackground(params.operationId, undefined, params.urlPrefix || '/api/du/v1', enrichedInput).catch(
      (err) => {
        this.app.logger?.error?.(`Failed resuming operation ${params.operationId}`, err);
      },
    );

    return {
      httpStatus: 202,
      operationId: params.operationId,
      state: refreshed.state,
      stateVersion: refreshed.stateVersion,
      replayed: false,
    };
  }

  async getOperationResult(tenantId: string, operationId: string): Promise<ResultEnvelope> {
    const op = await this.getOperationRecordOrThrow(tenantId, operationId);
    if (op.state === 'TIMED_OUT') {
      throw new DuHttpError(createProblem(410, 'GONE', `Operation ${operationId} timed out`));
    }
    if (op.state !== 'SUCCEEDED' || !op.resultEnvelope) {
      throw new DuHttpError(
        createProblem(409, 'STATE_CONFLICT', `Operation ${operationId} result is not ready (state=${op.state})`),
      );
    }
    return op.resultEnvelope;
  }

  async getUsageSummary(params: { tenantId: string; from: string; to: string }): Promise<UsageSummaryView> {
    const fromDate = new Date(params.from);
    const toDate = new Date(params.to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
      throw new DuHttpError(
        createProblem(422, 'INVALID_SCHEMA', 'Query parameters "from" and "to" must be valid ISO dates with from < to'),
      );
    }

    const filter: Record<string, unknown> = {
      createdAt: { $gte: fromDate, $lt: toDate },
    };
    if (params.tenantId !== '*') filter.tenantId = params.tenantId;

    const rows = await this.db.getRepository(OPERATIONS_COLLECTION).find({ filter });
    const plains = rows.map((r: unknown) => toPlain<OperationRecord>(r));

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    const grouped = new Map<
      string,
      {
        businessId: string;
        action: string;
        operations: number;
        inputTokens: number;
        outputTokens: number;
        costMicrousd: number;
      }
    >();

    for (const op of plains) {
      const u = op.usage;
      const inTok = u?.inputTokens || 0;
      const outTok = u?.outputTokens || 0;
      const cost = u?.costMicrousd || 0;
      totalInput += inTok;
      totalOutput += outTok;
      totalCost += cost;

      const key = `${op.businessId}:${op.action}`;
      const bucket = grouped.get(key) || {
        businessId: op.businessId,
        action: op.action,
        operations: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicrousd: 0,
      };
      bucket.operations += 1;
      bucket.inputTokens += inTok;
      bucket.outputTokens += outTok;
      bucket.costMicrousd += cost;
      grouped.set(key, bucket);
    }

    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      totalOperations: plains.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      costMicrousd: totalCost,
      byBusiness: Array.from(grouped.values()),
    };
  }

  async listUsageEvents(params: {
    tenantId: string;
    operationId?: string;
    provider?: string;
    model?: string;
    action?: string;
    limit?: number;
  }): Promise<{ items: Array<Record<string, unknown>> }> {
    const filter: Record<string, unknown> = {};
    if (params.tenantId !== '*') filter.tenantId = params.tenantId;
    if (params.operationId) filter.operationId = params.operationId;
    if (params.action) filter.action = params.action;

    const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
    const rows = await this.db.getRepository(OPERATIONS_COLLECTION).find({
      filter,
      sort: ['-createdAt'],
      limit,
    });

    const items = rows
      .map((r: unknown) => toPlain<OperationRecord>(r))
      .filter((op: OperationRecord) => {
        if (!op.usage) return false;
        if (params.model && op.usage.model !== params.model) return false;
        if (params.provider && op.usage.provider !== params.provider) return false;
        return true;
      })
      .map((op: OperationRecord) => ({
        operationId: op.operationId,
        businessId: op.businessId,
        action: op.action,
        state: op.state,
        createdAt: op.createdAt,
        ...op.usage,
      }));

    return { items };
  }
}
