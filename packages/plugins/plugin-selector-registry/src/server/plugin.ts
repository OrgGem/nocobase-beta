import { resolve } from 'path';

import { Plugin } from '@nocobase/server';

import { createAdminActions } from './actions/admin-actions';
import { createClientActions } from './actions/client-actions';
import { FeedbackService } from './services/feedback-service';
import { LLMResolver, PluginAiSelectorGateway } from './services/llm-resolver';
import { ResolvePipeline } from './services/resolve-pipeline';
import { SelectorSettingsService } from './services/settings-service';

const COLLECTION_RESOURCES = [
  'selectorApps',
  'selectorEntries',
  'selectorVersions',
  'selectorResolveLogs',
  'selectorFeedbacks',
];

export class PluginSelectorRegistryServer extends Plugin {
  private settingsService!: SelectorSettingsService;
  private pipeline!: ResolvePipeline;
  private feedbackService!: FeedbackService;
  private maintenanceJob: ReturnType<typeof this.app.cronJobManager.addJob> | null = null;

  async beforeLoad() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });
  }

  async load() {
    this.settingsService = new SelectorSettingsService(() => this.db.getRepository('selectorSettings'));
    this.pipeline = new ResolvePipeline({
      database: this.db,
      settings: this.settingsService,
      createLLMResolver: ({ llmService, model }) =>
        new LLMResolver(new PluginAiSelectorGateway(this.app, { llmService, model })),
    });
    this.feedbackService = new FeedbackService({ database: this.db, settings: this.settingsService });

    this.app.resourceManager.define({
      name: 'selectorRegistry',
      actions: createClientActions({
        database: this.db,
        pipeline: this.pipeline,
        feedback: this.feedbackService,
      }),
    });

    this.app.resourceManager.define({
      name: 'selectorRegistryAdmin',
      actions: createAdminActions({
        database: this.db,
        pipeline: this.pipeline,
        feedback: this.feedbackService,
        settings: this.settingsService,
        pruneLogs: () => this.pruneLogs(),
      }),
    });

    const clientActions = ['selectorRegistry:resolve', 'selectorRegistry:report', 'selectorRegistry:bulkLookup'];
    const readActions = [
      'selectorRegistryAdmin:getSettings',
      'selectorRegistryAdmin:stats',
      ...COLLECTION_RESOURCES.flatMap((resource) => [`${resource}:list`, `${resource}:get`]),
    ];
    const manageActions = [
      ...clientActions,
      ...readActions,
      'selectorRegistryAdmin:updateSettings',
      'selectorRegistryAdmin:revalidate',
      'selectorRegistryAdmin:rollbackVersion',
      'selectorRegistryAdmin:pruneLogs',
      ...COLLECTION_RESOURCES.flatMap((resource) => [
        `${resource}:create`,
        `${resource}:update`,
        `${resource}:destroy`,
      ]),
    ];
    this.app.acl.registerSnippet({ name: `pm.${this.name}.client`, actions: clientActions });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.read`, actions: readActions });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.manage`, actions: manageActions });

    this.maintenanceJob = this.app.cronJobManager.addJob({
      cronTime: '0 30 * * * *',
      onTick: () => {
        this.pruneLogs().catch((error) => {
          this.app.logger.error('[selector-registry] log pruning failed', error);
        });
      },
    });
  }

  async beforeStop() {
    if (this.maintenanceJob) {
      this.app.cronJobManager.removeJob(this.maintenanceJob);
      this.maintenanceJob = null;
    }
  }

  private async pruneLogs(): Promise<{ removedResolveLogs: number; removedFeedbacks: number }> {
    const settings = await this.settingsService.get();
    const retentionDays = settings.logRetentionDays;
    if (!retentionDays || retentionDays <= 0) {
      return { removedResolveLogs: 0, removedFeedbacks: 0 };
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const filter = { createdAt: { $lt: cutoff } };
    const removedResolveLogs = await this.db.getRepository('selectorResolveLogs').destroy({ filter });
    const removedFeedbacks = await this.db.getRepository('selectorFeedbacks').destroy({ filter });
    return { removedResolveLogs, removedFeedbacks };
  }
}

export default PluginSelectorRegistryServer;
