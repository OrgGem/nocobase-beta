// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import { COLLECTIONS, RCLONE_TRANSFER_INSTRUCTION_TYPE, RESOURCE_NAME } from '../../shared/constants';
import { resolveContextPermissions, type PermissionCheckContext } from '../permissions';

export const RCLONE_ACTION_METHODS: Readonly<Record<string, readonly string[]>> = {
  myPermissions: ['GET'],
  listConnections: ['GET'],
  createConnection: ['POST'],
  updateConnection: ['POST'],
  deleteConnection: ['POST'],
  testConnection: ['POST'],
  testConnectionDraft: ['POST'],
  dashboardSummary: ['GET'],
  remoteUsage: ['GET'],
  listProviders: ['GET'],
  listRemotes: ['GET'],
  getRemoteConfig: ['GET'],
  createRemote: ['POST'],
  updateRemote: ['POST'],
  deleteRemote: ['POST'],
  listDisks: ['GET'],
  listFiles: ['GET'],
  mkdir: ['POST'],
  deleteItem: ['POST'],
  renameItem: ['POST'],
  uploadFile: ['POST'],
  signDownload: ['POST'],
  downloadStream: ['GET'],
  triggerTransferWorkflow: ['POST'],
  listJobs: ['GET'],
  stopJob: ['POST'],
  listMountTypes: ['GET'],
  listMounts: ['GET'],
  createMount: ['POST'],
  unmount: ['POST'],
  unmountAll: ['POST'],
  listServeTypes: ['GET'],
  listServes: ['GET'],
  startServe: ['POST'],
  stopServe: ['POST'],
  stopAllServes: ['POST'],
  getRuntimeOptions: ['GET'],
  setRuntimeOptions: ['POST'],
  getRawConfig: ['GET'],
  saveRawConfig: ['POST'],
};

const PRIVATE_COLLECTIONS = new Set<string>([COLLECTIONS.connections, COLLECTIONS.tasks]);
const WORKFLOW_NODE_MUTATION_ACTIONS = new Set(['create', 'update', 'duplicate', 'test', 'load']);

function hasAllowLocalPathsConfig(node: unknown): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return false;
  }
  const config = (node as { config?: unknown }).config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return false;
  }
  return Boolean((config as Record<string, unknown>).allowLocalPaths);
}

function collectWorkflowNodePayloads(resourceName: string, values: readonly unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const item of values) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (resourceName === 'workflows') {
      if (Array.isArray(rec.nodes)) {
        for (const nested of rec.nodes) {
          if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            nodes.push(nested as Record<string, unknown>);
          }
        }
      }
    } else {
      nodes.push(rec);
    }
  }
  return nodes;
}

async function assertWorkflowNodeLocalFsAllowed(ctx: Context, resourceName: string): Promise<void> {
  if (resourceName !== 'flow_nodes' && resourceName !== 'workflows.nodes' && resourceName !== 'workflows') {
    return;
  }
  const actionName = String(ctx.action?.actionName ?? '');
  if (!WORKFLOW_NODE_MUTATION_ACTIONS.has(actionName)) {
    return;
  }
  const perms = resolveContextPermissions(ctx as unknown as PermissionCheckContext);
  if (perms.canLocalFs) {
    return;
  }

  const params = ctx.action?.params ?? {};
  const values = Array.isArray(params.values) ? params.values : [params.values];
  const nodePayloads = collectWorkflowNodePayloads(resourceName, values);

  for (const node of nodePayloads) {
    if (!hasAllowLocalPathsConfig(node)) {
      continue;
    }
    if (node.type === RCLONE_TRANSFER_INSTRUCTION_TYPE || (resourceName === 'flow_nodes' && node.type === undefined)) {
      ctx.throw(
        403,
        'High-privilege permission "local-fs" is required to enable allowLocalPaths on Rclone workflow nodes',
      );
    }
  }

  // On update/duplicate of an existing flow_nodes row, prevent non-local-fs users from modifying or cloning a node that already has allowLocalPaths enabled.
  if (
    resourceName === 'flow_nodes' &&
    (actionName === 'update' || actionName === 'duplicate') &&
    params.filterByTk != null
  ) {
    const repo = (
      ctx as {
        db?: {
          getRepository?: (name: string) => {
            findOne: (opts: Record<string, unknown>) => Promise<{ get: (k: string) => unknown } | null>;
          };
        };
      }
    ).db?.getRepository?.('flow_nodes');
    if (repo) {
      const existing = await repo.findOne({ filterByTk: params.filterByTk, fields: ['id', 'type', 'config'] });
      if (existing?.get('type') === RCLONE_TRANSFER_INSTRUCTION_TYPE) {
        const existingCfg = existing.get('config') as Record<string, unknown> | null | undefined;
        const existingAllow = Boolean(existingCfg?.allowLocalPaths);
        if (actionName === 'duplicate' && existingAllow) {
          ctx.throw(
            403,
            'High-privilege permission "local-fs" is required to duplicate an Rclone node with allowLocalPaths enabled',
          );
        }
        if (existingAllow) {
          const explicitlyDisabled = nodePayloads.some((node) => {
            const cfg = node.config as Record<string, unknown> | undefined;
            return cfg && 'allowLocalPaths' in cfg && cfg.allowLocalPaths === false;
          });
          if (!explicitlyDisabled) {
            ctx.throw(
              403,
              'High-privilege permission "local-fs" is required to modify an Rclone node with allowLocalPaths enabled',
            );
          }
        }
      }
    }
  }
}

export function createRcloneResourceGuardMiddleware() {
  return async (ctx: Context, next: Next) => {
    const resourceName = String(ctx.action?.resourceName ?? '');
    if (!resourceName) {
      await next();
      return;
    }

    // Block direct generic REST access to internal collections so all reads/writes pass through secret masking & local-fs guards
    const [sourceCollection] = resourceName.split('.');
    const params = ctx.action?.params ?? {};
    const values = Array.isArray(params.values) ? params.values : [params.values];
    const touchesPrivateCollection =
      PRIVATE_COLLECTIONS.has(sourceCollection) ||
      PRIVATE_COLLECTIONS.has(String(params.targetCollection ?? '')) ||
      values.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          PRIVATE_COLLECTIONS.has(String((item as Record<string, unknown>).__collection ?? '')),
      );

    if (touchesPrivateCollection) {
      ctx.throw(403, 'Direct collection access is disabled; use rcloneManager resource actions');
      return;
    }

    await assertWorkflowNodeLocalFsAllowed(ctx, resourceName);

    if (resourceName === RESOURCE_NAME) {
      const allowed = RCLONE_ACTION_METHODS[ctx.action.actionName];
      const method = ctx.method.toUpperCase();
      if (allowed && !allowed.includes(method)) {
        ctx.throw(405, `HTTP ${method} is not allowed for ${RESOURCE_NAME}:${ctx.action.actionName}`);
        return;
      }
    }

    await next();
  };
}
