import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';

export default class AddPlanApprovalAndHarnessProfiles extends Migration {
  on = 'afterLoad';
  appVersion = '>=0.1.0';

  async up() {
    const db = (this as any).db;
    const queryInterface = db.sequelize.getQueryInterface();
    const tablePrefix = db.options.tablePrefix || '';

    await this.addRunColumns(queryInterface, `${tablePrefix}agentLoopRuns`);
    await this.addStepColumns(queryInterface, `${tablePrefix}agentLoopSteps`);
    await this.addConfigColumns(queryInterface, `${tablePrefix}orchestratorConfig`);
    await this.ensureHarnessProfiles(queryInterface, `${tablePrefix}agentHarnessProfiles`);
    await this.seedDefaultProfiles();
  }

  async addRunColumns(queryInterface: any, tableName: string) {
    const tableExists = await queryInterface.tableExists(tableName).catch(() => false);
    if (!tableExists) return;
    const tableDesc = await queryInterface.describeTable(tableName);
    const addIfMissing = async (name: string, spec: any) => {
      if (tableDesc[name]) return;
      await queryInterface.addColumn(tableName, name, spec);
    };

    await addIfMissing('approvalStatus', { type: DataTypes.STRING(30), allowNull: true, defaultValue: 'none' });
    await addIfMissing('approvedById', { type: DataTypes.BIGINT, allowNull: true });
    await addIfMissing('approvedAt', { type: DataTypes.DATE, allowNull: true });
    await addIfMissing('rejectionReason', { type: DataTypes.TEXT, allowNull: true });
    await addIfMissing('changeRequest', { type: DataTypes.TEXT, allowNull: true });
    await addIfMissing('planVersion', { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 });
    await addIfMissing('planSource', { type: DataTypes.STRING(50), allowNull: true });
    await addIfMissing('plannerModel', { type: DataTypes.STRING(100), allowNull: true });
    await addIfMissing('lockedBy', { type: DataTypes.STRING(100), allowNull: true });
    await addIfMissing('lockedUntil', { type: DataTypes.DATE, allowNull: true });
  }

  async addStepColumns(queryInterface: any, tableName: string) {
    const tableExists = await queryInterface.tableExists(tableName).catch(() => false);
    if (!tableExists) return;
    const tableDesc = await queryInterface.describeTable(tableName);
    if (!tableDesc.dependencyPolicy) {
      await queryInterface.addColumn(tableName, 'dependencyPolicy', {
        type: DataTypes.STRING(30),
        allowNull: true,
        defaultValue: 'require_success',
      });
    }
  }

  async addConfigColumns(queryInterface: any, tableName: string) {
    const tableExists = await queryInterface.tableExists(tableName).catch(() => false);
    if (!tableExists) return;
    const tableDesc = await queryInterface.describeTable(tableName);
    if (!tableDesc.harnessTag) {
      await queryInterface.addColumn(tableName, 'harnessTag', {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: 'default',
      });
    }
  }

  async ensureHarnessProfiles(queryInterface: any, tableName: string) {
    const tableExists = await queryInterface.tableExists(tableName).catch(() => false);
    if (tableExists) return;
    await queryInterface.createTable(tableName, {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      tag: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      title: { type: DataTypes.STRING(200), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      enabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: true },
      settings: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: true },
      updatedAt: { type: DataTypes.DATE, allowNull: true },
    });
  }

  async seedDefaultProfiles() {
    const repo = (this as any).db.getRepository('agentHarnessProfiles');
    if (!repo) return;
    const profiles = [
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
        description:
          'Conservative native observer policy with private context enabled only for matching user/agent pairs.',
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
    for (const profile of profiles) {
      const existing = await repo.findOne({ filter: { tag: profile.tag } });
      if (existing) continue;
      await repo.create({
        values: {
          ...profile,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  }

  async down() {
    // No rollback: new nullable columns and the profile table are backward compatible.
  }
}
