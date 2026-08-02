import { Plugin } from '@nocobase/server';
import type { Database } from '@nocobase/database';
import { resolve } from 'path';
import { DataTypes } from 'sequelize';
import * as gitActions from './actions/git-actions';
import * as gitlabApi from './actions/gitlab-api';
import * as reviewActions from './actions/review';
import * as pollerActions from './actions/poller';
import * as rolePermissionsActions from './actions/role-permissions';
import * as subtreeActions from './actions/subtree';
import { recoverStuckReviews, registerReviewQueue, unregisterReviewQueue } from './actions/review';
import { registerGitReviewAiTools } from './ai-tools';
import { startPoller, stopPoller } from './poller';
import { RegistryGitContentService, SkillHubGitContentService } from './services/registry-content-service';
import { enforceRepositoryAccess, enforceRepositoryCollectionAccess } from './repository-access';
import { isGitManagerResourceResponse, redactCredentialFields } from './utils/redact';
import { containsCredentialBearingUrlField, URL_USERINFO_NOT_ALLOWED } from './utils/url-security';

const GIT_CONFIGURATION_URL_FIELDS = new Set(['repoUrl', 'baseUrl']);

export function isGitConfigurationUrlMutation(resourceName: unknown, actionName: unknown): boolean {
  return (
    typeof actionName === 'string' &&
    ['create', 'update'].includes(actionName) &&
    isGitManagerResourceResponse(resourceName)
  );
}

export class PluginGitManagerServer extends Plugin {
  // @ts-ignore
  declare app: any;
  // @ts-ignore
  declare db: any;
  registryContentService!: RegistryGitContentService;
  skillHubContentService!: SkillHubGitContentService;

  async afterAdd() {
    this.registryContentService = new RegistryGitContentService(
      (this as unknown as { db: Database }).db,
      undefined,
      this.app.acl,
    );
    this.skillHubContentService = new SkillHubGitContentService(
      (this as unknown as { db: Database }).db,
      undefined,
      this.app.acl,
    );
  }

  async beforeLoad() {
    await (this as any).app.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    (this as any).app.db.addMigrations({
      namespace: (this as any).name,
      directory: resolve(__dirname, 'migrations'),
      context: { plugin: this },
    });
  }

  async load() {
    // Ensure dayjs timezone + utc plugins are loaded globally to prevent 'm.startOf is not a function' errors
    const dayjsLib = require('dayjs');
    const utcPlugin = require('dayjs/plugin/utc');
    const timezonePlugin = require('dayjs/plugin/timezone');
    dayjsLib.extend(utcPlugin);
    dayjsLib.extend(timezonePlugin);

    (this as any).app.resourceManager.define({
      name: 'gitManager',
      actions: {
        clone: gitActions.clone,
        pull: gitActions.pull,
        push: gitActions.push,
        fetch: gitActions.fetch,
        diff: gitActions.diff,
        status: gitActions.status,
        log: gitActions.log,
        branches: gitActions.branches,
        checkout: gitActions.checkout,
        fileTree: gitActions.fileTree,
        fileContent: gitActions.fileContent,
        commitDetail: gitActions.commitDetail,
        mergeRequests: gitlabApi.mergeRequests,
        mergeRequestDetail: gitlabApi.mergeRequestDetail,
        mergeRequestNotes: gitlabApi.mergeRequestNotes,
        triggerReview: reviewActions.triggerReview,
        reviewApprovePost: reviewActions.reviewApprovePost,
        reviewReject: reviewActions.reviewReject,
        pollNow: pollerActions.pollNow,
        pollerStatus: pollerActions.pollerStatus,
        rolePermissions: rolePermissionsActions.rolePermissions,
        updateRolePermissions: rolePermissionsActions.updateRolePermissions,
        subtreePreview: subtreeActions.subtreePreview,
        subtreeOptions: subtreeActions.subtreeOptions,
        subtreeRun: subtreeActions.subtreeRunOnAppProcess,
        subtreeReplace: subtreeActions.subtreeRunOnAppProcess,
      },
    });

    (this as any).app.resourceManager.use(enforceRepositoryAccess);
    (this as any).app.resourceManager.use(enforceRepositoryCollectionAccess);

    // Suppress noisy workflow pre-action/post-action warnings for custom resources
    (this as any).app.use(async (ctx, next) => {
      if (ctx.logger && ctx.logger.warn) {
        const originalWarn = ctx.logger.warn.bind(ctx.logger);
        ctx.logger.warn = (message: any, ...args: any[]) => {
          if (
            typeof message === 'string' &&
            message.includes('[Workflow') &&
            message.includes('collection') &&
            message.includes('not found')
          ) {
            return ctx.logger;
          }
          return originalWarn(message, ...args);
        };
      }
      return next();
    });

    registerReviewQueue((this as any).app);
    registerGitReviewAiTools((this as any).app);

    (this as any).app.on('afterStart', async () => {
      await ensureAutoReviewFlowSchema((this as any).app).catch(
        (err) => (this as any).app.log?.error?.('plugin-git-manager: ensure schema error', err),
      );
      // Sweep any review left in `running` state from a previous process.
      recoverStuckReviews((this as any).app).catch(
        (err) => (this as any).app.log?.error?.('plugin-git-manager: recoverStuckReviews error', err),
      );
      subtreeActions
        .recoverStuckSubtreeRuns((this as any).app)
        .catch((err) => (this as any).app.log?.error?.('plugin-git-manager: recover subtree runs error', err));
      startPoller((this as any).app);
    });
    (this as any).app.on('beforeStop', () => {
      unregisterReviewQueue((this as any).app);
      stopPoller();
    });
    (this as any).app.on('beforeDestroy', () => {
      unregisterReviewQueue((this as any).app);
      stopPoller();
    });

    // Read-only operations available to all plugin users
    (this as any).app.acl.registerSnippet({
      name: `pm.${(this as any).name}.read`,
      actions: [
        'gitRepositories:list',
        'gitRepositories:get',
        'gitAccounts:list',
        'gitAccounts:get',
        'gitReviewFlows:list',
        'gitReviewFlows:get',
        'gitCodeReviews:list',
        'gitCodeReviews:get',
        'gitSubtreeConfigs:list',
        'gitSubtreeConfigs:get',
        'gitSubtreeRuns:list',
        'gitSubtreeRuns:get',
        'gitManager:status',
        'gitManager:log',
        'gitManager:branches',
        'gitManager:diff',
        'gitManager:fileTree',
        'gitManager:fileContent',
        'gitManager:commitDetail',
        'gitManager:mergeRequests',
        'gitManager:mergeRequestDetail',
        'gitManager:mergeRequestNotes',
        'gitManager:pollerStatus',
        'gitManager:subtreePreview',
        'gitManager:subtreeOptions',
      ],
    });

    // Write operations require separate permission
    (this as any).app.acl.registerSnippet({
      name: `pm.${(this as any).name}.write`,
      actions: [
        'gitRepositories:create',
        'gitRepositories:update',
        'gitRepositories:destroy',
        'gitReviewFlows:create',
        'gitReviewFlows:update',
        'gitReviewFlows:destroy',
        'gitCodeReviews:create',
        'gitCodeReviews:update',
        'gitCodeReviews:destroy',
        'gitManager:clone',
        'gitManager:pull',
        'gitManager:push',
        'gitManager:fetch',
        'gitManager:checkout',
        'gitManager:triggerReview',
        'gitManager:reviewApprovePost',
        'gitManager:reviewReject',
        'gitManager:pollNow',
        'gitSubtreeConfigs:create',
        'gitSubtreeConfigs:update',
        'gitSubtreeConfigs:destroy',
        'gitManager:subtreeRun',
      ],
    });

    (this as any).app.acl.registerSnippet({
      name: `pm.${(this as any).name}.subtreeReplace`,
      actions: ['gitManager:subtreeReplace'],
    });

    // Repositories config — CRUD on gitRepositories and gitAccounts (no operations)
    (this as any).app.acl.registerSnippet({
      name: `pm.${(this as any).name}.repositories`,
      actions: ['gitRepositories:*', 'gitAccounts:*'],
    });

    // Full management — all git manager actions
    (this as any).app.acl.registerSnippet({
      name: `pm.${(this as any).name}.manage`,
      actions: [
        // ACL snippet actions are resource:action patterns; nested snippet names
        // are not expanded by the core snippet manager.
        'gitRepositories:*',
        'gitAccounts:*',
        'gitReviewFlows:*',
        'gitCodeReviews:*',
        'gitSubtreeConfigs:*',
        'gitSubtreeRuns:*',
        'gitManager:*',
      ],
    });

    // Prevent overwriting PAT with obfuscated value on updates
    (this as any).app.resourceManager.use(async (ctx, next) => {
      const resource = ctx.action?.resourceName;

      if (
        resource === 'gitSubtreeConfigs' &&
        ['create', 'update'].includes(ctx.action?.actionName) &&
        ctx.action.params?.values
      ) {
        try {
          subtreeActions.validateSubtreeConfigInput(ctx.action.params.values);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.throw(400, ctx.t(message, { ns: (this as any).name }));
        }
      }

      if (resource === 'gitAccounts' && ctx.action?.actionName === 'destroy') {
        const accounts = await ctx.db.getRepository('gitAccounts').find({
          filterByTk: ctx.action.params?.filterByTk,
          filter: ctx.action.params?.filter,
          fields: ['id'],
        });
        const accountIds: Array<number | string> = [];
        for (const account of accounts as Array<{ get: (attribute: string) => number | string }>) {
          accountIds.push(account.get('id'));
        }
        if (accountIds.length > 0) {
          const repositoryCount = await ctx.db.getRepository('gitRepositories').count({
            filter: { gitAccountId: { $in: accountIds } },
          });
          if (repositoryCount > 0) {
            ctx.throw(
              409,
              ctx.t('Cannot delete this Git account because {{count}} repositories are using it', {
                ns: (this as any).name,
                count: repositoryCount,
              }),
            );
          }
        }
      }

      if (isGitConfigurationUrlMutation(resource, ctx.action?.actionName)) {
        const actionParams = ctx.action?.params;
        const requestBody = ctx.request?.body;
        const hasCredentialBearingUrl = [
          actionParams,
          actionParams?.values,
          requestBody,
          requestBody?.values,
          ctx.query,
          ctx.request?.query,
        ].some((source) => containsCredentialBearingUrlField(source, GIT_CONFIGURATION_URL_FIELDS));

        if (hasCredentialBearingUrl) {
          ctx.throw(400, ctx.t(URL_USERINFO_NOT_ALLOWED, { ns: (this as any).name }));
        }

        if (ctx.action.params?.values?.pat === '••••••••') {
          delete ctx.action.params.values.pat;
        }
        if (ctx.request.body?.pat === '••••••••') {
          delete ctx.request.body.pat;
        }
      }
      return next();
    });

    // Strip PAT from every Git Manager response, including nested association routes.
    (this as any).app.resourceManager.use(async (ctx, next) => {
      const resource = ctx.action?.resourceName;
      if (!isGitManagerResourceResponse(resource)) {
        return next();
      }
      await next();
      redactCredentialFields(ctx.body);
    });
  }

  async install() {
    await (this as any).app.db.getCollection('gitAccounts')?.sync();
    await (this as any).app.db.getCollection('gitRepositories')?.sync();
    await (this as any).app.db.getCollection('gitSubtreeConfigs')?.sync();
    await (this as any).app.db.getCollection('gitSubtreeRuns')?.sync();
  }

  async beforeDisable() {
    unregisterReviewQueue((this as any).app);
    stopPoller();
  }

  async beforeUnload() {
    unregisterReviewQueue((this as any).app);
    stopPoller();
  }
}

export async function ensureAutoReviewFlowSchema(app: any) {
  const sequelize = app.db?.sequelize;
  const queryInterface = sequelize?.getQueryInterface?.();
  if (!queryInterface) return;

  const tablePrefix = app.db.options?.tablePrefix || '';

  const repoTable = `${tablePrefix}gitRepositories`;
  const repoInfo = await queryInterface.describeTable(repoTable).catch(() => null);
  if (repoInfo && !repoInfo.autoReviewFlowId) {
    await queryInterface.addColumn(repoTable, 'autoReviewFlowId', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  }

  const reviewTable = `${tablePrefix}gitCodeReviews`;
  const reviewInfo = await queryInterface.describeTable(reviewTable).catch(() => null);
  if (reviewInfo && !reviewInfo.folderPath) {
    await queryInterface.addColumn(reviewTable, 'folderPath', {
      type: DataTypes.STRING,
      allowNull: true,
    });
  }
}

export default PluginGitManagerServer;
