import type { Database, Model, Transaction } from '@nocobase/database';
import { parseHarnessSettings, validateHarnessSettings } from './HarnessSchema';
import type { HarnessSettings } from './HarnessSchema';

type HarnessProfileVersion = {
  id: number;
  profileId: number;
  version: number;
  schemaVersion: number;
  status: 'draft' | 'published';
  settings: HarnessSettings;
  publishedById?: number | null;
  publishedAt?: Date | null;
};

function read(record: Model | Record<string, unknown>, key: string) {
  const model = record as Model & { get?: (name: string) => unknown };
  return typeof model.get === 'function' ? model.get(key) : (record as Record<string, unknown>)[key];
}

function positiveId(value: unknown, label: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function versionRecord(record: Model | Record<string, unknown>): HarnessProfileVersion {
  return {
    id: positiveId(read(record, 'id'), 'Harness profile version id'),
    profileId: positiveId(read(record, 'profileId'), 'Harness profile id'),
    version: positiveId(read(record, 'version'), 'Harness profile version'),
    schemaVersion: positiveId(read(record, 'schemaVersion'), 'Harness schema version'),
    status: read(record, 'status') === 'published' ? 'published' : 'draft',
    settings: parseHarnessSettings(read(record, 'settings')),
    publishedById: (read(record, 'publishedById') as number | null | undefined) || null,
    publishedAt: (read(record, 'publishedAt') as Date | null | undefined) || null,
  };
}

export class HarnessProfileService {
  constructor(private readonly database: Database) {}

  validate(settings: unknown) {
    return validateHarnessSettings(settings);
  }

  async createDraft(input: { profileId: number; settings: unknown; schemaVersion?: number }) {
    const profileId = positiveId(input.profileId, 'Harness profile id');
    const schemaVersion = positiveId(input.schemaVersion || 1, 'Harness schema version');
    const settings = parseHarnessSettings(input.settings);

    return this.database.sequelize.transaction(async (transaction) => {
      await this.lockProfile(profileId, transaction);
      const versions = this.database.getRepository('agentHarnessProfileVersions');
      const latest = await versions.findOne({
        filter: { profileId },
        sort: ['-version'],
        transaction,
      });
      const nextVersion = latest ? positiveId(read(latest, 'version'), 'Harness profile version') + 1 : 1;
      const draft = await versions.create({
        values: {
          profileId,
          version: nextVersion,
          schemaVersion,
          status: 'draft',
          settings,
        },
        transaction,
      });
      return versionRecord(draft);
    });
  }

  async updateDraft(versionId: number, settings: unknown) {
    const id = positiveId(versionId, 'Harness profile version id');
    const parsedSettings = parseHarnessSettings(settings);
    const versions = this.database.getRepository('agentHarnessProfileVersions');
    const version = await versions.findOne({ filterByTk: id });
    if (!version) throw new Error(`Harness profile version ${id} was not found.`);
    if (read(version, 'status') !== 'draft') {
      throw new Error('Published Harness profile versions are immutable.');
    }
    await versions.update({ filterByTk: id, values: { settings: parsedSettings } });
    const updated = await versions.findOne({ filterByTk: id });
    if (!updated) throw new Error(`Harness profile version ${id} was not found after update.`);
    return versionRecord(updated);
  }

  async publish(versionId: number, publishedById?: number) {
    const id = positiveId(versionId, 'Harness profile version id');
    return this.database.sequelize.transaction(async (transaction) => {
      const versions = this.database.getRepository('agentHarnessProfileVersions');
      const candidate = await versions.findOne({ filterByTk: id, transaction });
      if (!candidate) throw new Error(`Harness profile version ${id} was not found.`);
      const profileId = positiveId(read(candidate, 'profileId'), 'Harness profile id');
      await this.lockProfile(profileId, transaction);

      const current = await versions.findOne({ filterByTk: id, transaction });
      if (!current) throw new Error(`Harness profile version ${id} was not found.`);
      if (read(current, 'status') === 'published') {
        return versionRecord(current);
      }

      const settings = parseHarnessSettings(read(current, 'settings'));
      const now = new Date();
      await versions.update({
        filterByTk: id,
        values: {
          status: 'published',
          settings,
          publishedById: publishedById ? positiveId(publishedById, 'Publisher id') : null,
          publishedAt: now,
        },
        transaction,
      });
      await this.database.getRepository('agentHarnessProfiles').update({
        filterByTk: profileId,
        values: {
          currentVersionId: id,
          schemaVersion: positiveId(read(current, 'schemaVersion'), 'Harness schema version'),
        },
        transaction,
      });
      const published = await versions.findOne({ filterByTk: id, transaction });
      if (!published) throw new Error(`Harness profile version ${id} was not found after publish.`);
      return versionRecord(published);
    });
  }

  async getPublishedByTag(tag: string) {
    const normalizedTag = tag.trim();
    if (!normalizedTag) throw new Error('Harness profile tag is required.');
    const profile = await this.database.getRepository('agentHarnessProfiles').findOne({
      filter: { tag: normalizedTag, enabled: true },
    });
    if (!profile) return null;
    const currentVersionId = Number(read(profile, 'currentVersionId'));
    if (!Number.isSafeInteger(currentVersionId) || currentVersionId <= 0) return null;
    const version = await this.database.getRepository('agentHarnessProfileVersions').findOne({
      filter: { id: currentVersionId, status: 'published' },
    });
    return version ? versionRecord(version) : null;
  }

  private async lockProfile(profileId: number, transaction: Transaction) {
    const profile = await this.database.getRepository('agentHarnessProfiles').findOne({
      filterByTk: profileId,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!profile) throw new Error(`Harness profile ${profileId} was not found.`);
    return profile;
  }
}
