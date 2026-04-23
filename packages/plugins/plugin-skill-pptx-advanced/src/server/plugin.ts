import { Plugin } from '@nocobase/server';
import { PPTX_ADVANCED_SKILL } from './skill-definition';

export class PluginSkillPptxAdvancedServer extends Plugin {
  async afterAdd() {}
  async beforeLoad() {}

  async load() {}

  async install() {}

  // Dynamic discovery pull method for plugin-skill-hub
  getSkillTemplates() {
    return [PPTX_ADVANCED_SKILL];
  }

  // Fallback direct push method
  private registerSkill() {
    try {
      const skillHub = this.app.pm.get('plugin-skill-hub') as any;
      if (!skillHub) return;
      if (skillHub.registerSkillTemplate) {
        skillHub.registerSkillTemplate(this.name, PPTX_ADVANCED_SKILL);
      }
    } catch (err) {}
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
