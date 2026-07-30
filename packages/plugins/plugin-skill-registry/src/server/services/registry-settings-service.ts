import { getJson } from './model-values';
import type { RegistryDatabase } from './repository-types';

const SETTINGS_KEY = 'runtime';

export interface RegistryRuntimeOverrides {
  publicEnabled?: boolean;
  maxSourceItems?: number;
  maxSourceFileBytes?: number;
  downloadConcurrencyPerIp?: number;
  downloadConcurrencyGlobal?: number;
  downloadResponseTimeoutMs?: number;
  stuckRunMinutes?: number;
  downloadRetentionDays?: number;
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
        maxSourceItems: integerSetting(overrides.maxSourceItems, 'SKILL_REGISTRY_MAX_SOURCE_ITEMS', 1000),
        maxSourceFileBytes: integerSetting(
          overrides.maxSourceFileBytes,
          'SKILL_REGISTRY_MAX_SOURCE_FILE_BYTES',
          10 * 1024 * 1024,
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

  async applyRuntimeOverrides(): Promise<void> {
    const overrides = await this.overrides();
    const environmentNames: Partial<Record<keyof RegistryRuntimeOverrides, string>> = {
      maxSourceItems: 'SKILL_REGISTRY_MAX_SOURCE_ITEMS',
      maxSourceFileBytes: 'SKILL_REGISTRY_MAX_SOURCE_FILE_BYTES',
      downloadConcurrencyPerIp: 'SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_PER_IP',
      downloadConcurrencyGlobal: 'SKILL_REGISTRY_DOWNLOAD_CONCURRENCY_GLOBAL',
      downloadResponseTimeoutMs: 'SKILL_REGISTRY_DOWNLOAD_RESPONSE_TIMEOUT_MS',
      stuckRunMinutes: 'SKILL_REGISTRY_STUCK_RUN_MINUTES',
      downloadRetentionDays: 'SKILL_REGISTRY_DOWNLOAD_RETENTION_DAYS',
    };
    for (const [key, environmentName] of Object.entries(environmentNames)) {
      const value = overrides[key as keyof RegistryRuntimeOverrides];
      if (environmentName && typeof value === 'number') process.env[environmentName] = String(value);
    }
  }

  async update(overrides: RegistryRuntimeOverrides): Promise<ReturnType<RegistrySettingsService['effective']>> {
    const repository = this.database.getRepository('skillRegistrySettings');
    const record = await repository.findOne({ filter: { key: SETTINGS_KEY } });
    if (record) {
      await repository.update({ filter: { key: SETTINGS_KEY }, values: { overrides } });
    } else {
      await repository.create({ values: { key: SETTINGS_KEY, overrides } });
    }
    await this.applyRuntimeOverrides();
    return this.effective();
  }
}
