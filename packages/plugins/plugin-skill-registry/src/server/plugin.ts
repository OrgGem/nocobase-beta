import { resolve } from 'path';

import { Plugin } from '@nocobase/server';

import { createAdminActions, createHealthActions, createPublicActions } from './actions';
import { RegistryError } from './contracts/errors';
import type { RegistrySourceProvider } from './contracts/types';
import { createPublicRateLimitMiddleware } from './middlewares/public-rate-limit';
import { createRequestMethodPolicy } from './middlewares/request-method-policy';
import { createResourceMutationPolicy, resolveRegistryResourceName } from './middlewares/resource-mutation-policy';
import { createSourceMutationPolicy } from './middlewares/source-mutation-policy';
import { GitManagerSourceProvider } from './providers/git-manager-provider';
import { SkillHubSourceProvider } from './providers/skill-hub-provider';
import { CatalogService } from './services/catalog-service';
import { AgentInstallationBridge } from './services/agent-installation-bridge';
import { FilesystemArtifactStore } from './services/filesystem-artifact-store';
import { PublishService } from './services/publish-service';
import { PublicRateLimiter } from './services/public-rate-limiter';
import { RegistryMaintenanceService } from './services/registry-maintenance-service';
import { RegistrySettingsService } from './services/registry-settings-service';
import { distributedTopologyReady, RegistryReadinessService } from './services/registry-readiness-service';
import type { RegistryDatabase } from './services/repository-types';
import { SignatureService } from './services/signature-service';
import { SourceSyncService } from './services/source-sync-service';

const managementResourceNames = new Set([
  'skillRegistryAdmin',
  'skillRegistryHealth',
  'skillRegistrySources',
  'skillRegistrySourceItems',
  'skillRegistryPackages',
  'skillRegistryVersions',
  'skillRegistrySyncRuns',
  'skillRegistryArtifacts',
  'skillRegistryDownloads',
  'skillRegistrySettings',
]);

export class PluginSkillRegistryServer extends Plugin {
  private readonly database = this.db as unknown as RegistryDatabase;
  private readonly artifactStore = new FilesystemArtifactStore();
  private readonly signatureService = new SignatureService();
  private readonly sourceProviders: Map<string, RegistrySourceProvider> = new Map([
    ['skill-hub', new SkillHubSourceProvider(this.app.pm)],
    ['git-manager', new GitManagerSourceProvider(this.app.pm)],
  ]);
  private readonly catalogService = new CatalogService(this.database);
  private readonly installationBridge = new AgentInstallationBridge(
    this.database,
    this.artifactStore,
    this.app.pm,
    this.signatureService,
    this.app.lockManager,
  );
  private readonly sourceSyncService = new SourceSyncService(this.database, this.sourceProviders, this.app.lockManager);
  private readonly registryMaintenanceService = new RegistryMaintenanceService(
    this.database,
    this.artifactStore,
    this.app.lockManager,
  );
  private readonly registrySettingsService = new RegistrySettingsService(this.database);
  private readonly readinessService = new RegistryReadinessService(
    this.database,
    this.artifactStore,
    this.signatureService,
    () => this.publicRateLimiter,
  );
  private readonly publishService = new PublishService(
    this.database,
    this.sourceProviders,
    this.artifactStore,
    this.signatureService,
    this.app.lockManager,
  );
  private publicRateLimiter?: PublicRateLimiter;
  private maintenanceJob: ReturnType<typeof this.app.cronJobManager.addJob> | null = null;

  private readonly initializeRateLimiter = async () => {
    this.publicRateLimiter = await PublicRateLimiter.create(this.app);
    if (this.publicRateLimiter.scope === 'process-local' && process.env.NODE_ENV === 'production') {
      this.app.logger.warn(
        '[skill-registry] Public rate limiting is process-local. Configure SKILL_REGISTRY_RATE_LIMIT_STORE with a shared cache before running multiple replicas.',
      );
    }
  };

  private readonly runMaintenance = async () => {
    try {
      if (!distributedTopologyReady(this.publicRateLimiter?.scope || 'unavailable')) {
        this.app.logger.warn(
          '[skill-registry] maintenance skipped because cluster mode lacks shared rate-limit/storage/lock backends',
        );
        return;
      }
      const recoveredRuns = await this.sourceSyncService.recoverStuckRuns();
      const scheduled = await this.sourceSyncService.syncDueSources();
      await this.registryMaintenanceService.pruneDownloadAudit();
      const removedArtifacts = await this.registryMaintenanceService.garbageCollectOrphanArtifacts();
      if (recoveredRuns > 0 || scheduled.syncedCount > 0 || scheduled.errorCount > 0 || removedArtifacts > 0) {
        this.app.logger.info(
          `[skill-registry] maintenance recovered=${recoveredRuns} synced=${scheduled.syncedCount} errors=${scheduled.errorCount} orphanArtifacts=${removedArtifacts}`,
        );
      }
    } catch (error) {
      this.app.logger.error('[skill-registry] maintenance failed', error);
    }
  };

  private readonly removeMaintenanceJob = () => {
    if (!this.maintenanceJob) {
      return;
    }
    this.app.cronJobManager.removeJob(this.maintenanceJob);
    this.maintenanceJob = null;
  };

  async afterAdd() {
    this.app.on('afterLoad', this.initializeRateLimiter);
    this.app.on('afterStart', this.runMaintenance);
  }

  async beforeLoad() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });
  }

  async load() {
    this.maintenanceJob = this.app.cronJobManager.addJob({
      cronTime: '0 * * * * *',
      onTick: this.runMaintenance,
    });
    this.app.resourceManager.define({
      name: 'skillRegistryPublic',
      actions: createPublicActions({
        database: this.database,
        catalog: this.catalogService,
        artifactStore: this.artifactStore,
        rateLimiter: () => this.publicRateLimiter,
        signatureService: this.signatureService,
      }),
    });
    this.app.resourceManager.define({
      name: 'skillRegistryAdmin',
      actions: createAdminActions({
        database: this.database,
        sync: this.sourceSyncService,
        publish: this.publishService,
        installationBridge: this.installationBridge,
        lockManager: this.app.lockManager,
        settings: this.registrySettingsService,
      }),
    });
    this.app.resourceManager.define({
      name: 'skillRegistryHealth',
      actions: createHealthActions(this.readinessService),
    });

    this.app.acl.allow('skillRegistryPublic', ['list', 'get', 'versions', 'download', 'metadata'], 'public');
    const readActions = [
      'skillRegistrySources:list',
      'skillRegistrySources:get',
      'skillRegistrySourceItems:list',
      'skillRegistrySourceItems:get',
      'skillRegistryPackages:list',
      'skillRegistryPackages:get',
      'skillRegistryVersions:list',
      'skillRegistryVersions:get',
      'skillRegistrySyncRuns:list',
      'skillRegistrySyncRuns:get',
      'skillRegistryHealth:readiness',
      'skillRegistryAdmin:getSettings',
      'skillRegistryAdmin:installationStates',
    ];
    const syncActions = ['skillRegistryAdmin:discover', 'skillRegistryAdmin:sync', 'skillRegistryAdmin:retry'];
    // ADR-0002 §13: identity mapping (resolve) belongs to the publish permission, not sync.
    const publishActions = [
      'skillRegistryAdmin:resolve',
      'skillRegistryAdmin:publish',
      'skillRegistryAdmin:publishBatch',
      'skillRegistryAdmin:yank',
      'skillRegistryAdmin:unpublish',
      'skillRegistryAdmin:unpublishBatch',
      'skillRegistryAdmin:yankImpact',
      'skillRegistryAdmin:verify',
    ];
    const installActions = ['skillRegistryAdmin:install', 'skillRegistryAdmin:rollback'];
    this.app.acl.registerSnippet({ name: `pm.${this.name}.read`, actions: readActions });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.sync`, actions: syncActions });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.publish`, actions: publishActions });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.install`, actions: installActions });
    // ACL snippets match resource:action patterns only; snippet names inside `actions` do not expand.
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.manage`,
      actions: [
        ...new Set([
          ...readActions,
          ...syncActions,
          ...publishActions,
          ...installActions,
          'skillRegistrySources:create',
          'skillRegistrySources:update',
          'skillRegistrySources:destroy',
          'skillRegistryAdmin:updateSettings',
        ]),
      ],
    });

    this.app.resourceManager.use(createRequestMethodPolicy());
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action.resourceName.startsWith('skillRegistry'))
        await this.registrySettingsService.applyRuntimeOverrides();
      await next();
    });
    this.app.resourceManager.use(
      createPublicRateLimitMiddleware(
        () => this.publicRateLimiter,
        () => this.registrySettingsService.publicEnabled(),
      ),
    );
    this.app.resourceManager.use(async (ctx, next) => {
      const resourceName = resolveRegistryResourceName(ctx) || ctx.action.resourceName;
      const { actionName } = ctx.action;
      if (!managementResourceNames.has(resourceName)) {
        await next();
        return;
      }
      if (!ctx.state.currentUser) {
        throw new RegistryError(
          'AUTHENTICATION_REQUIRED',
          401,
          'Authentication is required for Skill Registry management.',
        );
      }
      const roles = Array.isArray(ctx.state.currentRoles) ? ctx.state.currentRoles : [];
      const permission = this.app.acl.can({
        roles,
        resource: resourceName,
        action: actionName,
        rawResourceName: ctx.action.resourceName,
      });
      if (!permission) {
        throw new RegistryError('FORBIDDEN', 403, 'Skill Registry management permission is required.');
      }
      await next();
    });
    this.app.resourceManager.use(createResourceMutationPolicy());
    this.app.resourceManager.use(
      createSourceMutationPolicy({
        database: this.database,
        lockManager: this.app.lockManager,
        providers: this.sourceProviders,
      }),
    );
  }

  private readonly removeAppListeners = () => {
    this.app.off('afterLoad', this.initializeRateLimiter);
    this.app.off('afterStart', this.runMaintenance);
  };

  async beforeStop() {
    this.removeAppListeners();
    this.removeMaintenanceJob();
  }

  async afterDisable() {
    this.removeAppListeners();
    this.removeMaintenanceJob();
  }
}

export default PluginSkillRegistryServer;
