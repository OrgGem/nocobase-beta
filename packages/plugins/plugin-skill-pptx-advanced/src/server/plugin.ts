import { Plugin } from '@nocobase/server';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { PPTX_ADVANCED_SKILL } from './skill-definition';

export class PluginSkillPptxAdvancedServer extends Plugin {
  async afterAdd() {}
  async beforeLoad() {}

  async load() {}

  async install() {}

  // Dynamic discovery pull method for plugin-skill-hub
  getSkillTemplates() {
    return [
      {
        ...PPTX_ADVANCED_SKILL,
        skillPackage: {
          rootDir: this.getSkillPackageRoot(),
          mountMode: 'reference',
        },
        storageUrl: `plugin://${this.name}/${PPTX_ADVANCED_SKILL.name}`,
      },
    ];
  }

  // Fallback direct push method
  private registerSkill() {
    try {
      const skillHub = this.app.pm.get('plugin-skill-hub') as any;
      if (!skillHub) return;
      if (skillHub.registerSkillTemplate) {
        skillHub.registerSkillTemplate(this.name, this.getSkillTemplates()[0]);
      }
    } catch (err) {}
  }

  private getSkillPackageRoot() {
    const candidates = [
      resolve(__dirname, 'skills/pptx-advanced-export'),
      resolve(__dirname, '../../src/server/skills/pptx-advanced-export'),
      resolve(__dirname, '../src/server/skills/pptx-advanced-export'),
    ];

    const found = candidates.find((candidate) => existsSync(resolve(candidate, 'SKILL.md')));
    return found || candidates[0];
  }

  async afterLoad() {
    this.registerSkill();
    this.app.on('afterStart', () => this.registerSkill());
  }

  async afterEnable() {
    this.registerSkill();
  }

  async afterStart() {
    this.registerSkill();
  }

  async remove() {
    // Clean up when plugin is uninstalled
    // Note: Since skill is now a template, we just let it be.
  }
}

export default PluginSkillPptxAdvancedServer;
