/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getJson } from './model-values';
import type { RegistryDatabase } from './repository-types';

const SETTINGS_KEY = 'runtime';

export interface RegistryRuntimeOverrides {
  publicEnabled?: boolean;
  maxSourceItems?: number;
  maxSourceFileBytes?: number;
  maxSourceTreeEntries?: number;
  maxSourceTreeOutputBytes?: number;
  maxFiles?: number;
  maxExpandedBytes?: number;
  maxArtifactBytes?: number;
  downloadConcurrencyPerIp?: number;
  downloadConcurrencyGlobal?: number;
  downloadResponseTimeoutMs?: number;
  stuckRunMinutes?: number;
  downloadRetentionDays?: number;
}

const operationSettings = new AsyncLocalStorage<RegistryRuntimeOverrides>();

export function currentRegistryOverride(key: keyof Omit<RegistryRuntimeOverrides, 'publicEnabled'>) {
  return operationSettings.getStore()?.[key];
}

export function registryLimit(key: keyof Omit<RegistryRuntimeOverrides, 'publicEnabled'>, environmentName: string) {
  return currentRegistryOverride(key)?.toString() ?? process.env[environmentName];
}

type EffectiveSetting<T> = { value: T; source: 'ui' | 'environment' | 'default' };

const integerSetting = (
  override: number | undefined,
  environmentName: string,
  fallback: number,
): EffectiveSetting<number> => {
  if (override !== undefined) {
    return { value: override, source: 'ui' };
  }
  const environmentValue = Number(process.env[environmentName]);
  if (Number.isSafeInteger(environmentValue) && environmentValue > 0) {
    return { value: environmentValue, source: 'environment' };
  }
  return { value: fallback, source: 'default' };
};

export class RegistrySettingsService {
  constructor(private readonly database: RegistryDatabase) {}

  async overrides(): Promise<RegistryRuntimeOverrides> {
    const record = await this.database
      .getRepository('skillRegistrySettings')
      .findOne({ filter: { key: SETTINGS_KEY } });
    return record ? (getJson(record, 'overrides') as RegistryRuntimeOverrides) : {};
  }

  async effective() {
    const overrides = await this.overrides();
    const environmentPublic = process.env.SKILL_REGISTRY_PUBLIC_ENABLED?.trim().toLowerCase();
    const publicEnabled: EffectiveSetting<boolean> =
      overrides.publicEnabled !== undefined
        ? { value: overrides.publicEnabled, source: 'ui' }
        : environmentPublic === 'true' || environmentPublic === 'false'
          ? { value: environmentPublic === 'true', source: 'environment' }
          : { value: false, source: 'default' };

    return {
      overrides,
      effective: {
        publicEnabled,
        maxSourceItems: integerSetting(overrides.maxSourceItems, 'SKILL_REGISTRY_MAX_SOURCE_ITEMS', 5000),
        maxSourceFileBytes: integerSetting(
          overrides.maxSourceFileBytes,
          'SKILL_REGISTRY_MAX_SOURCE_FILE_BYTES',
          100 * 1024 * 1024,
        ),
        maxSourceTreeEntries: integerSetting(
          overrides.maxSourceTreeEntries,
          'SKILL_REGISTRY_MAX_SOURCE_TREE_ENTRIES',
          50000,
        ),
        maxSourceTreeOutputBytes: integerSetting(
          overrides.maxSourceTreeOutputBytes,
          'SKILL_REGISTRY_MAX_SOURCE_TREE_OUTPUT_BYTES',
          64 * 1024 * 1024,
        ),
        maxFiles: integerSetting(overrides.maxFiles, 'SKILL_REGISTRY_MAX_FILES', 10000),
        maxExpandedBytes: integerSetting(
          overrides.maxExpandedBytes,
          'SKILL_REGISTRY_MAX_EXPANDED_BYTES',
          1024 * 1024 * 1024,
        ),
        maxArtifactBytes: integerSetting(
          overrides.maxArtifactBytes,
          'SKILL_REGISTRY_MAX_ARTIFACT_BYTES',
          500 * 1024 * 1024,
        ),
        downloadConcurrencyPerIp: integerSetting(
          overrides.downloadConcurrencyPerIp,
          'SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP',
          3,
        ),
        downloadConcurrencyGlobal: integerSetting(
          overrides.downloadConcurrencyGlobal,
          'SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL',
          20,
        ),
        downloadResponseTimeoutMs: integerSetting(
          overrides.downloadResponseTimeoutMs,
          'SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS',
          5 * 60 * 1000,
        ),
        stuckRunMinutes: integerSetting(overrides.stuckRunMinutes, 'SKILL_REGISTRY_STUCK_RUN_MINUTES', 60),
        downloadRetentionDays: integerSetting(
          overrides.downloadRetentionDays,
          'SKILL_REGISTRY_DOWNLOAD_RETENTION_DAYS',
          90,
        ),
      },
    };
  }

  async publicEnabled(): Promise<boolean> {
    return (await this.effective()).effective.publicEnabled.value;
  }

  async withRuntimeOverrides<T>(operation: () => Promise<T>): Promise<T> {
    return operationSettings.run(await this.overrides(), operation);
  }

  async update(overrides: RegistryRuntimeOverrides): Promise<ReturnType<RegistrySettingsService['effective']>> {
    const repository = this.database.getRepository('skillRegistrySettings');
    const record = await repository.findOne({ filter: { key: SETTINGS_KEY } });
    if (record) {
      await repository.update({ filter: { key: SETTINGS_KEY }, values: { overrides } });
    } else {
      await repository.create({ values: { key: SETTINGS_KEY, overrides } });
    }
    return this.effective();
  }
}
