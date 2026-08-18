export interface SelectorRegistrySettings {
  enabled: boolean;
  llmService: string | null;
  llmModel: string | null;
  confidenceThreshold: number;
  quarantineThreshold: number;
  probationSuccessTarget: number;
  failStreakLimit: number;
  rollbackFailLimit: number;
  circuitBreakerMaxHeals: number;
  circuitBreakerWindowMs: number;
  circuitBreakerCooldownMs: number;
  entryTtlMs: number;
  domSnippetMaxChars: number;
  logRetentionDays: number;
  ewmaAlpha: number;
}

export const DEFAULT_SETTINGS: SelectorRegistrySettings = {
  enabled: true,
  llmService: null,
  llmModel: null,
  confidenceThreshold: 0.6,
  quarantineThreshold: 0.3,
  probationSuccessTarget: 3,
  failStreakLimit: 3,
  rollbackFailLimit: 2,
  circuitBreakerMaxHeals: 3,
  circuitBreakerWindowMs: 10 * 60 * 1000,
  circuitBreakerCooldownMs: 30 * 60 * 1000,
  entryTtlMs: 0,
  domSnippetMaxChars: 20000,
  logRetentionDays: 30,
  ewmaAlpha: 0.25,
};

const SETTINGS_KEY = 'runtime';

type SettingsRepository = {
  findOne(options: { filter: Record<string, unknown> }): Promise<{ get(name: string): unknown } | null>;
  create(options: { values: Record<string, unknown> }): Promise<unknown>;
  update(options: { filter: Record<string, unknown>; values: Record<string, unknown> }): Promise<unknown>;
};

export class SelectorSettingsService {
  constructor(private readonly repository: () => SettingsRepository) {}

  async get(): Promise<SelectorRegistrySettings> {
    const record = await this.repository().findOne({ filter: { key: SETTINGS_KEY } });
    if (!record) return { ...DEFAULT_SETTINGS };
    const values = (record.get('values') ?? {}) as Partial<SelectorRegistrySettings>;
    return { ...DEFAULT_SETTINGS, ...values };
  }

  async update(patch: Partial<SelectorRegistrySettings>): Promise<SelectorRegistrySettings> {
    const current = await this.get();
    const next = { ...current, ...sanitizePatch(patch) };
    const record = await this.repository().findOne({ filter: { key: SETTINGS_KEY } });
    if (record) {
      await this.repository().update({ filter: { key: SETTINGS_KEY }, values: { values: next } });
    } else {
      await this.repository().create({ values: { key: SETTINGS_KEY, values: next } });
    }
    return next;
  }
}

const NUMERIC_KEYS: (keyof SelectorRegistrySettings)[] = [
  'confidenceThreshold',
  'quarantineThreshold',
  'probationSuccessTarget',
  'failStreakLimit',
  'rollbackFailLimit',
  'circuitBreakerMaxHeals',
  'circuitBreakerWindowMs',
  'circuitBreakerCooldownMs',
  'entryTtlMs',
  'domSnippetMaxChars',
  'logRetentionDays',
  'ewmaAlpha',
];

const sanitizePatch = (patch: Partial<SelectorRegistrySettings>): Partial<SelectorRegistrySettings> => {
  const clean: Partial<SelectorRegistrySettings> = {};
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if ('llmService' in patch) clean.llmService = patch.llmService ? String(patch.llmService) : null;
  if ('llmModel' in patch) clean.llmModel = patch.llmModel ? String(patch.llmModel) : null;
  for (const key of NUMERIC_KEYS) {
    const value = patch[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  return clean;
};
