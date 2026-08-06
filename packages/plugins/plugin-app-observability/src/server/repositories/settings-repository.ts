export interface ObservabilitySettings {
  enabled: boolean;
  sampleIntervalSeconds: number;
  bucketSeconds: number;
  retentionDays: number;
  activeUserWindowSeconds: number;
  redisSnapshotsEnabled: boolean;
  prometheusEnabled: boolean;
  capacityThresholdCpu: number;
  capacityThresholdMemory: number;
  capacityThresholdEventLoop: number;
  capacityThresholdDbWait: number;
}
export const DEFAULT_SETTINGS: ObservabilitySettings = {
  enabled: true,
  sampleIntervalSeconds: 10,
  bucketSeconds: 60,
  retentionDays: 14,
  activeUserWindowSeconds: 300,
  redisSnapshotsEnabled: false,
  prometheusEnabled: false,
  capacityThresholdCpu: 75,
  capacityThresholdMemory: 80,
  capacityThresholdEventLoop: 70,
  capacityThresholdDbWait: 5,
};
interface SettingsModel {
  toJSON?(): Record<string, unknown>;
  [key: string]: unknown;
}
interface SettingsStore {
  findOne(options?: Record<string, unknown>): Promise<SettingsModel | null>;
  create(options: { values: Record<string, unknown> }): Promise<unknown>;
  update(options: { filter: Record<string, unknown>; values: Record<string, unknown> }): Promise<unknown>;
}
export class SettingsRepository {
  constructor(private readonly store: SettingsStore) {}
  async get(): Promise<ObservabilitySettings> {
    const model = await this.store.findOne({ filter: { key: 'default' } });
    const values = model?.toJSON?.() ?? model ?? {};
    return { ...DEFAULT_SETTINGS, ...pickSettings(values) };
  }
  async ensureDefaults(): Promise<ObservabilitySettings> {
    const model = await this.store.findOne({ filter: { key: 'default' } });
    if (!model) await this.store.create({ values: { key: 'default', ...DEFAULT_SETTINGS } });
    return model ? this.get() : DEFAULT_SETTINGS;
  }
  async update(values: Partial<ObservabilitySettings>): Promise<ObservabilitySettings> {
    validateSettings(values);
    await this.ensureDefaults();
    await this.store.update({ filter: { key: 'default' }, values: pickSettings(values) });
    return this.get();
  }
}
function pickSettings(values: Record<string, unknown>): Partial<ObservabilitySettings> {
  const result: Partial<ObservabilitySettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof ObservabilitySettings>)
    if (values[key] !== undefined) Object.assign(result, { [key]: values[key] });
  return result;
}
function validateSettings(values: Partial<ObservabilitySettings>): void {
  for (const key of ['enabled', 'redisSnapshotsEnabled', 'prometheusEnabled'] as const) {
    if (values[key] !== undefined && typeof values[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  const ranges: Partial<Record<keyof ObservabilitySettings, [number, number]>> = {
    sampleIntervalSeconds: [5, 300],
    bucketSeconds: [10, 3600],
    retentionDays: [1, 365],
    activeUserWindowSeconds: [30, 3600],
    capacityThresholdCpu: [1, 100],
    capacityThresholdMemory: [1, 100],
    capacityThresholdEventLoop: [1, 100],
    capacityThresholdDbWait: [1, 100],
  };
  for (const [key, range] of Object.entries(ranges) as Array<[keyof ObservabilitySettings, [number, number]]>) {
    const value = values[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < range[0] || value > range[1])
    )
      throw new TypeError(`${key} is out of range`);
  }
}
