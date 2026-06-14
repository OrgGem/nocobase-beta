import { Plugin } from '@nocobase/server';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_CREATOR_SKILL } from './skill-definition';

type SkillHubLike = {
  skillHub?: SkillHubLike;
  registerSkillTemplate?: (pluginName: string, template: unknown) => void;
};

function stringifyJsonText(value: unknown, fallback: unknown = null): string {
  const normalized = value === undefined || value === null || value === '' ? fallback : value;
  return `\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
}

function readPackageText(rootDir: string, filename: string) {
  const path = resolve(rootDir, filename);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function parseSkillMarkdown(markdown: string) {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return match ? markdown.substring(match[0].length).trim() : markdown.trim();
}

export class PluginSkillCreatorServer extends Plugin {
  async afterAdd() {}
  async beforeLoad() {}
  async load() {
    this.registerSkill();
    await this.ensureSkillDefinition();

    this.app.on('afterLoad', async () => {
      this.registerSkill();
      await this.ensureSkillDefinition();
    });

    this.app.on('afterStart', async () => {
      this.registerSkill();
      await this.ensureSkillDefinition();
    });
  }

  async install() {
    await this.ensureSkillDefinition();
  }

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
      const skillHubPlugin = this.app.pm.get('plugin-skill-hub') as unknown as SkillHubLike | undefined;
      const orchestratorPlugin = this.app.pm.get('plugin-agent-orchestrator') as unknown as SkillHubLike | undefined;
      const skillHub = skillHubPlugin || orchestratorPlugin?.skillHub;
      if (!skillHub) return;
      if (skillHub.registerSkillTemplate) {
        skillHub.registerSkillTemplate(this.name, this.getSkillTemplates()[0]);
      }
    } catch (err) {
      this.app.logger?.warn?.('[plugin-skill-creator] Failed to register create-skill template', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ensureSkillDefinition() {
    try {
      const repo = this.db.getRepository('skillDefinitions');
      if (!repo) return;

      const template = this.getSkillTemplates()[0];
      const packageRoot = template.skillPackage.rootDir;
      const instructions = parseSkillMarkdown(readPackageText(packageRoot, 'SKILL.md'));
      const codeTemplate = readPackageText(packageRoot, 'index.py');
      if (!codeTemplate) {
        this.app.logger?.warn?.('[plugin-skill-creator] create-skill package code was not found', {
          packageRoot,
        });
        return;
      }

      const values = {
        name: template.name,
        title: template.title,
        description: template.description,
        instructions,
        language: template.language,
        codeTemplate,
        inputSchema: stringifyJsonText(template.inputSchema),
        packages: stringifyJsonText(template.packages || [], []),
        timeoutSeconds: template.timeoutSeconds || 30,
        maxOutputSizeMb: template.maxOutputSizeMb || 5,
        enabled: template.enabled !== false,
        toolScope: template.toolScope || 'CUSTOM',
        autoCall: false,
        storageType: 'plugin',
        storageUrl: template.storageUrl,
        pluginSource: template.name,
      };

      const existing = await repo.findOne({ filter: { name: template.name } });
      if (existing) {
        await repo.update({ filter: { name: template.name }, values });
      } else {
        await repo.create({ values });
      }
    } catch (err) {
      this.app.logger?.warn?.('[plugin-skill-creator] Failed to ensure create-skill Skill Hub definition', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  async afterEnable() {
    this.registerSkill();
    await this.ensureSkillDefinition();
  }

  async remove() {}
}

export default PluginSkillCreatorServer;
