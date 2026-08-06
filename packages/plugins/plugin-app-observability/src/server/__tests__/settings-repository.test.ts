import { describe, expect, it, vi } from 'vitest';
import { SettingsRepository } from '../repositories/settings-repository';

describe('SettingsRepository', () => {
  it('creates defaults without overwriting existing values and validates updates', async () => {
    const store = { findOne: vi.fn().mockResolvedValue({ retentionDays: 7 }), create: vi.fn(), update: vi.fn() };
    const repository = new SettingsRepository(store);
    await expect(repository.ensureDefaults()).resolves.toMatchObject({ retentionDays: 7, sampleIntervalSeconds: 10 });
    expect(store.create).not.toHaveBeenCalled();
    await expect(repository.update({ retentionDays: 0 })).rejects.toThrow('retentionDays');
  });
});
