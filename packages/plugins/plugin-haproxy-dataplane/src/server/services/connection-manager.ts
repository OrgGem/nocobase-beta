// SPDX-License-Identifier: Apache-2.0

import type { Model } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { COLLECTIONS, DEFAULT_TIMEOUT_MS, SECRET_MASK } from '../../shared/constants';
import type { HaproxyAuthType, HaproxyConnectionPublic } from '../../shared/types';
import { hasEnvironmentPermission, type PermissionCheckContext } from '../permissions';
import {
  clampTimeoutMs,
  DataplaneApiError,
  DataplaneV3Client,
  normalizeDataplaneV3BaseUrl,
  type DataplaneV3ClientConfig,
} from './dataplane-v3-client';

export const ENV_REFERENCE_REGEX = /\{\{\s*\$env\.([a-zA-Z0-9_]+)\s*\}\}/g;

export class HaproxyConnectionManager {
  private readonly cache = new Map<number, { configKey: string; client: DataplaneV3Client }>();

  constructor(private readonly app: Application) {}

  invalidate(id: number): void {
    this.cache.delete(id);
  }

  clear(): void {
    this.cache.clear();
  }

  resolveEnv(val: string | null | undefined, allowSecrets = false): string {
    if (!val || typeof val !== 'string') {
      return '';
    }
    const envService = this.app.environment;
    if (!envService) {
      return val;
    }
    const vars = (allowSecrets ? envService.getVariablesAndSecrets() : envService.getNonSecretVariables()) as Record<
      string,
      unknown
    >;
    return val.replace(ENV_REFERENCE_REGEX, (match, varName: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, varName)) {
        return match;
      }
      const resolved = vars[varName];
      return resolved == null ? '' : String(resolved);
    });
  }

  async decryptPassword(rawPassword: string | null | undefined): Promise<string> {
    if (!rawPassword) {
      return '';
    }
    try {
      return await this.app.aesEncryptor.decrypt(rawPassword);
    } catch {
      return rawPassword;
    }
  }

  async encryptPassword(plainPassword: string): Promise<string> {
    return this.app.aesEncryptor.encrypt(plainPassword);
  }

  containsEnvRef(text: string | null | undefined): boolean {
    if (!text) return false;
    ENV_REFERENCE_REGEX.lastIndex = 0;
    return ENV_REFERENCE_REGEX.test(text);
  }

  assertEnvReferencesPermitted(fields: ReadonlyArray<string | null | undefined>, ctx?: PermissionCheckContext): void {
    if (fields.some((val) => this.containsEnvRef(val)) && !hasEnvironmentPermission(ctx)) {
      throw new DataplaneApiError(
        'Environment variable references require environmentVariables update permission',
        403,
      );
    }
  }

  resolveNormalizedUrl(rawUrl: string): string {
    return normalizeDataplaneV3BaseUrl(this.resolveEnv(rawUrl, false));
  }

  async buildClientConfig(connection: Model): Promise<DataplaneV3ClientConfig> {
    const rawUrl = String(connection.get('baseUrl') ?? '');
    const resolvedUrl = this.resolveNormalizedUrl(rawUrl);
    const authType: HaproxyAuthType = connection.get('authType') === 'none' ? 'none' : 'basic';
    const rawUsername = String(connection.get('username') ?? '');
    const decryptedPassword = await this.decryptPassword(connection.get('password') as string | null);

    return {
      baseUrl: resolvedUrl,
      authType,
      username: this.resolveEnv(rawUsername, true),
      password: this.resolveEnv(decryptedPassword, true),
      tlsSkipVerify: Boolean(connection.get('tlsSkipVerify')),
      timeoutMs: clampTimeoutMs(connection.get('timeoutMs')),
    };
  }

  async getClientByModel(connection: Model): Promise<DataplaneV3Client> {
    const id = Number(connection.get('id'));
    const config = await this.buildClientConfig(connection);
    const configKey = JSON.stringify(config);
    const hit = this.cache.get(id);
    if (hit && hit.configKey === configKey) {
      return hit.client;
    }
    const client = new DataplaneV3Client(config);
    if (Number.isFinite(id) && id > 0) {
      this.cache.set(id, { configKey, client });
    }
    return client;
  }

  async getConnectionModel(connectionId: number | string, requireEnabled = true): Promise<Model> {
    const numericId = Number(connectionId);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new DataplaneApiError('Valid connectionId is required', 400);
    }
    const repo = this.app.db.getRepository(COLLECTIONS.connections);
    const model = await repo.findOne({ filterByTk: numericId });
    if (!model) {
      throw new DataplaneApiError(`HAProxy connection #${numericId} was not found`, 404);
    }
    if (requireEnabled && model.get('enabled') === false) {
      throw new DataplaneApiError(`HAProxy connection "${String(model.get('name'))}" is disabled`, 400);
    }
    return model;
  }

  async getClient(
    connectionId: number | string,
    requireEnabled = true,
  ): Promise<{ model: Model; client: DataplaneV3Client }> {
    const model = await this.getConnectionModel(connectionId, requireEnabled);
    const client = await this.getClientByModel(model);
    return { model, client };
  }

  toPublicConnection(model: Model, includeAdminDetails = false): HaproxyConnectionPublic {
    const hasPass = Boolean(model.get('password'));
    const timeoutRaw = Number(model.get('timeoutMs'));
    return {
      id: Number(model.get('id')),
      name: String(model.get('name') ?? ''),
      title: (model.get('title') as string | null) ?? null,
      baseUrl: includeAdminDetails ? String(model.get('baseUrl') ?? '') : '',
      authType: model.get('authType') === 'none' ? 'none' : 'basic',
      username: includeAdminDetails ? (model.get('username') as string | null) ?? '' : null,
      password: includeAdminDetails && hasPass ? SECRET_MASK : null,
      tlsSkipVerify: Boolean(model.get('tlsSkipVerify')),
      timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
      enabled: model.get('enabled') !== false,
      notes: includeAdminDetails ? (model.get('notes') as string | null) ?? null : null,
      lastCheckAt: model.get('lastCheckAt') ? new Date(String(model.get('lastCheckAt'))).toISOString() : null,
      lastApiVersion: (model.get('lastApiVersion') as string | null) ?? null,
      lastHaproxyVersion: (model.get('lastHaproxyVersion') as string | null) ?? null,
      lastError: includeAdminDetails ? (model.get('lastError') as string | null) ?? null : null,
    };
  }
}
