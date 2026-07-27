import { Migration } from '@nocobase/server';

export default class RemoveUnusedKnowledgeScopes extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const repo = this.db.getRepository('agentHarnessProfiles');
    const profiles = await repo.find({});

    for (const profile of profiles) {
      const settings = profile.get?.('settings') ?? profile.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !('knowledgeScopes' in settings)) {
        continue;
      }

      const { knowledgeScopes: _unused, ...nextSettings } = settings as Record<string, unknown>;
      await profile.update({ settings: nextSettings, updatedAt: new Date() });
    }
  }

  async down() {
    // The removed key never affected runtime behavior, so there is no data to restore.
  }
}
