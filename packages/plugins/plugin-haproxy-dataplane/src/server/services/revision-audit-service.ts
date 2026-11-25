// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { COLLECTIONS, MAX_AUDIT_LOGS_PER_NODE, MAX_REVISIONS_PER_NODE } from '../../shared/constants';
import { computeConfigDiff, normalizeConfigLines } from '../../shared/diff';
import type {
  ConfigDiffResult,
  HaproxyAuditCategory,
  HaproxyAuditLogRecord,
  HaproxyConfigRevisionDetail,
  HaproxyConfigRevisionSummary,
  HaproxyRevisionSource,
} from '../../shared/types';
import type { HaproxyConnectionManager } from './connection-manager';
import { DataplaneApiError, type DataplaneV3Client } from './dataplane-v3-client';

interface ActorInfo {
  actorUserId: number | null;
  actorName: string | null;
}

function extractActor(ctx?: Context): ActorInfo {
  const user = (ctx?.state as { currentUser?: Record<string, unknown> } | undefined)?.currentUser;
  if (!user) {
    return { actorUserId: null, actorName: null };
  }
  const rawId = Number(user.id);
  const name =
    (typeof user.nickname === 'string' && user.nickname.trim()) ||
    (typeof user.username === 'string' && user.username.trim()) ||
    (typeof user.email === 'string' && user.email.trim()) ||
    null;
  return {
    actorUserId: Number.isFinite(rawId) && rawId > 0 ? rawId : null,
    actorName: name,
  };
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

function toIsoOrNull(val: unknown): string | null {
  if (!val) return null;
  const d = new Date(String(val));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function toRevisionSummary(model: Model): HaproxyConfigRevisionSummary {
  const verRaw = model.get('configVersion');
  const actorIdRaw = model.get('actorUserId');
  return {
    id: Number(model.get('id')),
    connectionId: Number(model.get('connectionId')),
    connectionName: String(model.get('connectionName') ?? ''),
    configVersion: verRaw != null && Number.isFinite(Number(verRaw)) ? Number(verRaw) : null,
    checksum: (model.get('checksum') as string | null) ?? null,
    source: String(model.get('source') ?? 'manual_snapshot'),
    summary: (model.get('summary') as string | null) ?? null,
    lineCount: Number(model.get('lineCount') ?? 0),
    byteSize: Number(model.get('byteSize') ?? 0),
    actorUserId: actorIdRaw != null && Number.isFinite(Number(actorIdRaw)) ? Number(actorIdRaw) : null,
    actorName: (model.get('actorName') as string | null) ?? null,
    createdAt: toIsoOrNull(model.get('createdAt')),
  };
}

export function toRevisionDetail(model: Model): HaproxyConfigRevisionDetail {
  return {
    ...toRevisionSummary(model),
    rawContent: String(model.get('rawContent') ?? ''),
  };
}

export function toAuditLogRecord(model: Model): HaproxyAuditLogRecord {
  const connIdRaw = model.get('connectionId');
  const actorIdRaw = model.get('actorUserId');
  return {
    id: Number(model.get('id')),
    connectionId: connIdRaw != null && Number.isFinite(Number(connIdRaw)) ? Number(connIdRaw) : null,
    connectionName: (model.get('connectionName') as string | null) ?? null,
    category: String(model.get('category') ?? 'config'),
    action: String(model.get('action') ?? ''),
    target: (model.get('target') as string | null) ?? null,
    status: String(model.get('status') ?? 'success'),
    detail: (model.get('detail') as string | null) ?? null,
    actorUserId: actorIdRaw != null && Number.isFinite(Number(actorIdRaw)) ? Number(actorIdRaw) : null,
    actorName: (model.get('actorName') as string | null) ?? null,
    createdAt: toIsoOrNull(model.get('createdAt')),
  };
}

export class HaproxyRevisionAuditService {
  constructor(
    private readonly app: Application,
    private readonly connectionManager: HaproxyConnectionManager,
  ) {}

  private getRepoSafe(collectionName: string) {
    try {
      return this.app.db?.getRepository?.(collectionName) ?? null;
    } catch {
      return null;
    }
  }

  async recordAudit(
    ctx: Context | undefined,
    entry: {
      connectionId?: number | null;
      connectionName?: string | null;
      category: HaproxyAuditCategory;
      action: string;
      target?: string | null;
      status?: 'success' | 'failed';
      detail?: string | null;
    },
  ): Promise<void> {
    const repo = this.getRepoSafe(COLLECTIONS.auditLogs);
    if (!repo || typeof repo.create !== 'function') {
      return;
    }
    try {
      const actor = extractActor(ctx);
      await repo.create({
        values: {
          connectionId: entry.connectionId ?? null,
          connectionName: entry.connectionName ?? null,
          category: entry.category,
          action: entry.action,
          target: entry.target ?? null,
          status: entry.status ?? 'success',
          detail: entry.detail ? entry.detail.slice(0, 2000) : null,
          actorUserId: actor.actorUserId,
          actorName: actor.actorName,
        },
      });

      if (entry.connectionId && typeof repo.find === 'function' && typeof repo.destroy === 'function') {
        const rows = await repo.find({
          filter: { connectionId: entry.connectionId },
          sort: ['-id'],
        });
        if (rows.length > MAX_AUDIT_LOGS_PER_NODE) {
          const staleIds = rows.slice(MAX_AUDIT_LOGS_PER_NODE).map((r) => Number(r.get('id')));
          for (const id of staleIds) {
            await repo.destroy({ filterByTk: id });
          }
        }
      }
    } catch (err) {
      this.app.logger?.warn?.(`[plugin-haproxy-dataplane] Audit write skipped: ${String(err)}`);
    }
  }

  async captureRevision(opts: {
    connectionId: number;
    connectionName: string;
    client: DataplaneV3Client;
    source: HaproxyRevisionSource;
    summary?: string | null;
    ctx?: Context;
    deduplicate?: boolean;
  }): Promise<HaproxyConfigRevisionSummary | null> {
    const repo = this.getRepoSafe(COLLECTIONS.revisions);
    if (!repo || typeof repo.create !== 'function') {
      return null;
    }

    const liveRaw = await opts.client.getRawConfig();
    const rawContent = liveRaw.content;
    const checksum = liveRaw.checksum ?? sha256Hex(rawContent);

    if (opts.deduplicate !== false && typeof repo.find === 'function') {
      const existing = await repo.find({
        filter: { connectionId: opts.connectionId },
        sort: ['-id'],
        limit: 1,
      });
      const latest = existing[0];
      if (latest && String(latest.get('checksum') ?? '') === checksum) {
        return toRevisionSummary(latest);
      }
    }

    const actor = extractActor(opts.ctx);
    const lineCount = normalizeConfigLines(rawContent).length;
    const byteSize = Buffer.byteLength(rawContent, 'utf8');

    const created = await repo.create({
      values: {
        connectionId: opts.connectionId,
        connectionName: opts.connectionName,
        configVersion: liveRaw.version,
        checksum,
        rawContent,
        source: opts.source,
        summary: opts.summary ? opts.summary.trim().slice(0, 255) : null,
        lineCount,
        byteSize,
        actorUserId: actor.actorUserId,
        actorName: actor.actorName,
      },
    });

    if (typeof repo.find === 'function' && typeof repo.destroy === 'function') {
      const allForNode = await repo.find({
        filter: { connectionId: opts.connectionId },
        sort: ['-id'],
      });
      if (allForNode.length > MAX_REVISIONS_PER_NODE) {
        const pruneIds = allForNode.slice(MAX_REVISIONS_PER_NODE).map((r) => Number(r.get('id')));
        for (const pruneId of pruneIds) {
          await repo.destroy({ filterByTk: pruneId });
        }
      }
    }

    return toRevisionSummary(created);
  }

  async captureRevisionBestEffort(opts: {
    connectionId: number;
    connectionName: string;
    client: DataplaneV3Client;
    source: HaproxyRevisionSource;
    summary?: string | null;
    ctx?: Context;
  }): Promise<void> {
    try {
      await this.captureRevision({ ...opts, deduplicate: true });
    } catch (err) {
      this.app.logger?.warn?.(`[plugin-haproxy-dataplane] Auto-snapshot skipped: ${String(err)}`);
    }
  }

  async listRevisions(connectionId?: number): Promise<HaproxyConfigRevisionSummary[]> {
    const repo = this.app.db.getRepository(COLLECTIONS.revisions);
    const filter: Record<string, unknown> = {};
    if (connectionId != null && Number.isFinite(Number(connectionId)) && Number(connectionId) > 0) {
      filter.connectionId = Number(connectionId);
    }
    const rows = await repo.find({
      filter,
      sort: ['-id'],
      limit: 100,
    });
    return rows.map(toRevisionSummary);
  }

  async getRevisionModel(revisionId: number | string): Promise<Model> {
    const id = Number(revisionId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new DataplaneApiError('Valid revisionId is required', 400);
    }
    const repo = this.app.db.getRepository(COLLECTIONS.revisions);
    const model = await repo.findOne({ filterByTk: id });
    if (!model) {
      throw new DataplaneApiError(`Config revision #${id} was not found`, 404);
    }
    return model;
  }

  async getRevisionDetail(revisionId: number | string): Promise<HaproxyConfigRevisionDetail> {
    const model = await this.getRevisionModel(revisionId);
    return toRevisionDetail(model);
  }

  async diffRevisions(opts: {
    leftRevisionId: number | string;
    rightRevisionId?: number | string | null;
    connectionId?: number | string | null;
  }): Promise<ConfigDiffResult> {
    const leftModel = await this.getRevisionModel(opts.leftRevisionId);
    const leftDetail = toRevisionDetail(leftModel);
    const leftLabel = `${leftDetail.connectionName} #${leftDetail.id}${
      leftDetail.configVersion != null ? ` (v${leftDetail.configVersion})` : ''
    }`;

    if (
      opts.rightRevisionId != null &&
      String(opts.rightRevisionId) !== '' &&
      String(opts.rightRevisionId) !== 'live'
    ) {
      const rightModel = await this.getRevisionModel(opts.rightRevisionId);
      const rightDetail = toRevisionDetail(rightModel);
      const rightLabel = `${rightDetail.connectionName} #${rightDetail.id}${
        rightDetail.configVersion != null ? ` (v${rightDetail.configVersion})` : ''
      }`;
      return computeConfigDiff(leftDetail.rawContent, rightDetail.rawContent, leftLabel, rightLabel);
    }

    const targetConnId = opts.connectionId != null ? Number(opts.connectionId) : leftDetail.connectionId;
    const { model, client } = await this.connectionManager.getClient(targetConnId, true);
    const liveRaw = await client.getRawConfig();
    const rightLabel = `${String(model.get('name'))} (Live${liveRaw.version != null ? ` v${liveRaw.version}` : ''})`;
    return computeConfigDiff(leftDetail.rawContent, liveRaw.content, leftLabel, rightLabel);
  }

  async diffLiveNodes(
    leftConnectionId: number | string,
    rightConnectionId: number | string,
  ): Promise<ConfigDiffResult> {
    const [leftConn, rightConn] = await Promise.all([
      this.connectionManager.getClient(leftConnectionId, true),
      this.connectionManager.getClient(rightConnectionId, true),
    ]);
    const [leftRaw, rightRaw] = await Promise.all([leftConn.client.getRawConfig(), rightConn.client.getRawConfig()]);
    const leftLabel = `${String(leftConn.model.get('name'))}${
      leftRaw.version != null ? ` (Live v${leftRaw.version})` : ''
    }`;
    const rightLabel = `${String(rightConn.model.get('name'))}${
      rightRaw.version != null ? ` (Live v${rightRaw.version})` : ''
    }`;
    return computeConfigDiff(leftRaw.content, rightRaw.content, leftLabel, rightLabel);
  }

  async listAuditLogs(opts?: { connectionId?: number; category?: string }): Promise<HaproxyAuditLogRecord[]> {
    const repo = this.app.db.getRepository(COLLECTIONS.auditLogs);
    const filter: Record<string, unknown> = {};
    if (opts?.connectionId != null && Number.isFinite(Number(opts.connectionId)) && Number(opts.connectionId) > 0) {
      filter.connectionId = Number(opts.connectionId);
    }
    if (opts?.category && opts.category !== '__all__') {
      filter.category = opts.category;
    }
    const rows = await repo.find({
      filter,
      sort: ['-id'],
      limit: 100,
    });
    return rows.map(toAuditLogRecord);
  }
}
