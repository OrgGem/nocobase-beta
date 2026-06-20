import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';
import { normalizeAIEmployeeSkillSettings } from '../utils/skill-settings';

type ProfileSeed = {
  tag: string;
  title: string;
  description: string;
  settings: Record<string, unknown>;
};

const nativePolicyProfiles: ProfileSeed[] = [
  {
    tag: 'default',
    title: 'Default',
    description: 'Default native observer and memory policy for normal AI employee work.',
    settings: {
      nativeObserverEnabled: true,
      memoryInjectionEnabled: true,
      memoryScopes: ['public', 'user', 'agent_user'],
      knowledgeScopes: ['public', 'private'],
      maxMemoryContextChars: 6000,
      tracingRetentionDays: 30,
    },
  },
  {
    tag: 'safe',
    title: 'Safe',
    description: 'Conservative native observer policy with private context enabled only for matching user/agent pairs.',
    settings: {
      nativeObserverEnabled: true,
      memoryInjectionEnabled: true,
      memoryScopes: ['public', 'user', 'agent_user'],
      knowledgeScopes: ['public', 'private'],
      maxMemoryContextChars: 4000,
      tracingRetentionDays: 14,
    },
  },
  {
    tag: 'file-heavy',
    title: 'File Heavy',
    description: 'Native observer policy for agents that need more context while working with files and artifacts.',
    settings: {
      nativeObserverEnabled: true,
      memoryInjectionEnabled: true,
      memoryScopes: ['public', 'user', 'agent_user'],
      knowledgeScopes: ['public', 'private'],
      maxMemoryContextChars: 8000,
      tracingRetentionDays: 30,
      preferFileTools: true,
    },
  },
];

function readModelValue(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function asObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function dropRetiredPolicyKeys(settings: Record<string, unknown>) {
  const retired = new Set([
    'requirePlanApproval',
    'allowSubAgents',
    'allowToolCalls',
    'maxParallelSubAgents',
    'maxControllerSteps',
    'requireVerification',
  ]);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !retired.has(key)));
}

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildContextKey(record: Record<string, unknown>) {
  const scope = normalizeOptionalString(record.scope);
  const userPart = scope === 'public' ? 'public' : String(record.userId || '');
  const agentPart = normalizeOptionalString(record.aiEmployeeUsername) || '*';
  return `${scope}:${userPart}:${agentPart}`;
}

export default class NativePolicyProfileDefaults extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    await this.ensureNativePolicyProfiles();
    await this.ensureAgentMemoryContextKeys();
    await this.normalizeAIEmployeeToolBindings();
  }

  private async ensureNativePolicyProfiles() {
    const repo = (this as unknown as { db: { getRepository: (name: string) => any } }).db.getRepository(
      'agentHarnessProfiles',
    );
    if (!repo) return;

    for (const profile of nativePolicyProfiles) {
      const existing = await repo.findOne({ filter: { tag: profile.tag } });
      if (!existing) {
        await repo.create({
          values: {
            ...profile,
            enabled: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        continue;
      }

      const currentSettings = asObject(readModelValue(existing, 'settings'));
      const nextSettings = {
        ...profile.settings,
        ...dropRetiredPolicyKeys(currentSettings),
      };
      await existing.update({
        settings: nextSettings,
        updatedAt: new Date(),
      });
    }
  }

  private async ensureAgentMemoryContextKeys() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const tableName = `${db.options.tablePrefix || ''}agentMemoryContexts`;
    const tableExists = await queryInterface
      .describeTable(tableName)
      .then(() => true)
      .catch(() => false);
    if (!tableExists) return;

    const tableDesc = await queryInterface.describeTable(tableName);
    if (!tableDesc.contextKey) {
      await queryInterface.addColumn(tableName, 'contextKey', {
        type: DataTypes.STRING(300),
        allowNull: true,
      });
    }

    const repo = db.getRepository('agentMemoryContexts');
    const rows = await repo.find({});
    for (const row of rows) {
      const data = row.toJSON?.() || row;
      if (!normalizeOptionalString(data.scope)) continue;
      const contextKey = normalizeOptionalString(data.contextKey) || buildContextKey(data);
      if (!contextKey) continue;
      if (contextKey !== data.contextKey) {
        await row.update({ contextKey });
      }
    }

    await queryInterface
      .changeColumn(tableName, 'contextKey', {
        type: DataTypes.STRING(300),
        allowNull: false,
      })
      .catch(() => {});

    await queryInterface
      .addIndex(tableName, ['contextKey'], {
        unique: true,
        name: `${tableName}_contextKey_unique`,
      })
      .catch(() => {});
  }

  private async normalizeAIEmployeeToolBindings() {
    const repo = (this as unknown as { db: { getRepository: (name: string) => any } }).db.getRepository('aiEmployees');
    if (!repo) return;

    const rows = await repo.find({});
    for (const row of rows) {
      const skillSettings = row.get?.('skillSettings') ?? row.skillSettings;
      const normalized = normalizeAIEmployeeSkillSettings(skillSettings);
      if (!normalized.changed) continue;
      await row.update({
        skillSettings: normalized.skillSettings,
      });
    }
  }

  async down() {
    // No rollback: these defaults only add native policy keys and normalize
    // context keys required by the current unique constraint.
  }
}
