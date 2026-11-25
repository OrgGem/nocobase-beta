// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import { COLLECTIONS, RESOURCE_NAME } from '../../shared/constants';

export const HAPROXY_ACTION_METHODS: Readonly<Record<string, readonly string[]>> = {
  myPermissions: ['GET'],
  listConnections: ['GET'],
  fleetOverview: ['GET'],
  listReverseProxies: ['GET'],
  getSnapshot: ['GET'],
  listRuntimeMaps: ['GET'],
  getRuntimeMapEntries: ['GET'],
  listStickTables: ['GET'],
  getStickTableEntries: ['GET'],
  getConfigVersion: ['GET'],
  listTransactions: ['GET'],
  listReloads: ['GET'],
  listRevisions: ['GET'],
  getRevision: ['GET'],
  diffRevisions: ['GET'],
  diffLiveNodes: ['GET'],
  listAuditLogs: ['GET'],
  getRawConfig: ['GET'],
  listFrontends: ['GET'],
  listBinds: ['GET'],
  listFrontendAcls: ['GET'],
  listBackendSwitchingRules: ['GET'],
  listFrontendHttpRequestRules: ['GET'],
  listBackends: ['GET'],
  listBackendServers: ['GET'],
  listSslCertificates: ['GET'],
  listStorageMaps: ['GET'],
  getStorageMapContent: ['GET'],
  listStorageGeneralFiles: ['GET'],
  getStorageGeneralFileContent: ['GET'],

  updateRuntimeServer: ['POST'],
  addRuntimeServer: ['POST'],
  deleteRuntimeServer: ['POST'],
  addRuntimeMapEntry: ['POST'],
  updateRuntimeMapEntry: ['POST'],
  deleteRuntimeMapEntry: ['POST'],

  createSnapshot: ['POST'],
  rollbackRevision: ['POST'],

  startTransaction: ['POST'],
  commitTransaction: ['POST'],
  deleteTransaction: ['POST'],
  upsertReverseProxy: ['POST'],
  toggleReverseProxy: ['POST'],
  deleteReverseProxy: ['POST'],
  createFrontend: ['POST'],
  updateFrontend: ['POST'],
  deleteFrontend: ['POST'],
  createBind: ['POST'],
  updateBind: ['POST'],
  deleteBind: ['POST'],
  replaceFrontendAcls: ['POST'],
  replaceBackendSwitchingRules: ['POST'],
  replaceFrontendHttpRequestRules: ['POST'],
  createBackend: ['POST'],
  updateBackend: ['POST'],
  deleteBackend: ['POST'],
  createBackendServer: ['POST'],
  updateBackendServer: ['POST'],
  deleteBackendServer: ['POST'],

  pushRawConfig: ['POST'],
  pushRawConfigBatch: ['POST'],

  uploadSslCertificate: ['POST'],
  replaceSslCertificate: ['POST'],
  deleteSslCertificate: ['POST'],
  syncSslCertificateBatch: ['POST'],
  createStorageMap: ['POST'],
  replaceStorageMap: ['POST'],
  deleteStorageMap: ['POST'],
  createStorageGeneralFile: ['POST'],
  replaceStorageGeneralFile: ['POST'],
  deleteStorageGeneralFile: ['POST'],

  createConnection: ['POST'],
  updateConnection: ['POST'],
  deleteConnection: ['POST'],
  testConnection: ['POST'],
  testConnectionDraft: ['POST'],
};

const PRIVATE_COLLECTIONS = new Set<string>([COLLECTIONS.connections, COLLECTIONS.revisions, COLLECTIONS.auditLogs]);

export function createHaproxyResourceGuardMiddleware() {
  return async (ctx: Context, next: Next) => {
    const resourceName = String(ctx.action?.resourceName ?? '');
    if (!resourceName) {
      await next();
      return;
    }

    const [sourceCollection] = resourceName.split('.');
    const params = ctx.action?.params ?? {};
    const values = Array.isArray(params.values) ? params.values : [params.values];
    const touchesPrivateCollection =
      PRIVATE_COLLECTIONS.has(sourceCollection) ||
      PRIVATE_COLLECTIONS.has(String(params.targetCollection ?? '')) ||
      values.some(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          PRIVATE_COLLECTIONS.has(String((item as Record<string, unknown>).__collection ?? '')),
      );

    if (touchesPrivateCollection) {
      ctx.throw(403, `Direct collection access is disabled; use ${RESOURCE_NAME} resource actions`);
      return;
    }

    if (resourceName === RESOURCE_NAME) {
      const allowed = HAPROXY_ACTION_METHODS[ctx.action.actionName];
      const method = ctx.method.toUpperCase();
      if (allowed && !allowed.includes(method)) {
        ctx.throw(405, `HTTP ${method} is not allowed for ${RESOURCE_NAME}:${ctx.action.actionName}`);
        return;
      }
    }

    await next();
  };
}
