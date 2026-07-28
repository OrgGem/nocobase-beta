import { Migration } from '@nocobase/server';
import { buildSkillToolName, readRecordValue } from '../utils/skill-tool-name';

export default class BackfillSkillToolNames extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const repo = this.db.getRepository('skillDefinitions');
    if (!repo) return;

    const skills = await repo.find({ sort: ['id'] });
    const used = new Set<string>();

    for (const skill of skills) {
      const current = readRecordValue(skill, 'toolName');
      if (typeof current === 'string' && current.trim()) {
        used.add(current.trim());
      }
    }

    for (const skill of skills) {
      const current = readRecordValue(skill, 'toolName');
      if (typeof current === 'string' && current.trim()) continue;

      const id = readRecordValue(skill, 'id');
      const baseName = buildSkillToolName(String(readRecordValue(skill, 'name') || ''));
      let toolName = baseName;
      if (used.has(toolName)) {
        toolName = `${baseName}_${id}`;
      }

      await repo.update({
        filterByTk: id,
        values: { toolName },
      });
      used.add(toolName);
    }
  }

  async down() {
    // Stable tool identities are intentionally retained on rollback so AI
    // employee bindings do not become orphaned.
  }
}
