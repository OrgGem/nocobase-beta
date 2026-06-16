import { Migration } from '@nocobase/server';
import { normalizeAIEmployeeSkillSettings } from '../utils/skill-settings';

export default class NormalizeAIEmployeeToolBindings extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const repo = (this as unknown as { db: { getRepository: (name: string) => any }; app?: any }).db.getRepository(
      'aiEmployees',
    );
    if (!repo) return;

    const rows = await repo.find({});
    let updated = 0;

    for (const row of rows) {
      const skillSettings = row.get?.('skillSettings') ?? row.skillSettings;
      const normalized = normalizeAIEmployeeSkillSettings(skillSettings);
      if (!normalized.changed) continue;

      await row.update({
        skillSettings: normalized.skillSettings,
      });
      updated += 1;
    }

    if (updated > 0) {
      (this as unknown as { app?: { logger?: { info?: (message: string) => void } } }).app?.logger?.info?.(
        `[AgentOrchestrator] Normalized AI employee tool bindings (${updated}).`,
      );
    }
  }

  async down() {
    // No rollback: this only moves tool-shaped entries from skillSettings.skills
    // into the current NocoBase skillSettings.tools shape.
  }
}
