import { Plugin } from '@nocobase/server';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { SKILL_CREATOR_SKILL } from './skill-definition';

export class PluginSkillCreatorServer extends Plugin {
  async afterAdd() {}
  async beforeLoad() {}
  async load() {}
  async install() {}

  getSkillTemplates() {
    return [
      {
        ...SKILL_CREATOR_SKILL,
        skillPackage: {
          rootDir: this.getSkillPackageRoot(),
          mountMode: 'reference',
        },
        storageUrl: `plugin://${this.name}/${SKILL_CREATOR_SKILL.name}`,
      },
    ];
  }

  private registerSkill() {
    try {
      const skillHubPlugin = this.app.pm.get('plugin-skill-hub') as any;
      const orchestratorPlugin = this.app.pm.get('plugin-agent-orchestrator') as any;
      const skillHub = skillHubPlugin || orchestratorPlugin?.skillHub;
      if (!skillHub) return;
      if (skillHub.registerSkillTemplate) {
        skillHub.registerSkillTemplate(this.name, this.getSkillTemplates()[0]);
      }
    } catch (err) {}
  }

  private getSkillPackageRoot() {
    const candidates = [
      resolve(__dirname, 'skills/create-skill'),
      resolve(__dirname, '../../src/server/skills/create-skill'),
      resolve(__dirname, '../src/server/skills/create-skill'),
    ];

    const found = candidates.find((candidate) => existsSync(resolve(candidate, 'SKILL.md')));
    return found || candidates[0];
  }

  async afterLoad() {
    this.registerSkill();
    (this.app as any).on('afterStart', () => this.registerSkill());
  }

  async afterEnable() {
    this.registerSkill();
  }

  async afterStart() {
    this.registerSkill();
  }

  async remove() {}
}

export default PluginSkillCreatorServer;
