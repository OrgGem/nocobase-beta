/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import type { Context } from '@nocobase/actions';
import type { Database } from '@nocobase/database';
import { resolve } from 'path';
import { DataTypes } from 'sequelize';
import * as gitActions from './actions/git-actions';
import * as gitlabApi from './actions/gitlab-api';
import * as reviewActions from './actions/review';
import * as reviewCutoverActions from './actions/review-cutover';
import * as pollerActions from './actions/poller';
import * as rolePermissionsActions from './actions/role-permissions';
import * as subtreeActions from './actions/subtree';
import { unregisterReviewQueue } from './actions/review';
import { registerGitReviewAiTools } from './ai-tools';
import { enforceGitRequestMethod } from './request-method-policy';
import { startPoller, stopPoller } from './poller';
import { RegistryGitContentService, SkillHubGitContentService } from './services/registry-content-service';
import { GitReviewService } from './services/review-service';
import { LegacyPostService } from './services/legacy-post-service';
import { enforceReviewControlAccess } from './review-control-access';
import { enforceRepositoryAccess, enforceRepositoryCollectionAccess } from './repository-access';
import { isGitManagerResourceResponse, redactCredentialFields } from './utils/redact';
import { containsCredentialBearingUrlField, URL_USERINFO_NOT_ALLOWED } from './utils/url-security';

const GIT_CONFIGURATION_URL_FIELDS = new Set(['repoUrl', 'baseUrl']);

function isConcurrentSchemaChange(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const databaseError = error as { original?: { code?: string; errno?: number; message?: string }; message?: string };
  const code = databaseError.original?.code;
  const number = databaseError.original?.errno;
  const message = databaseError.original?.message || databaseError.message || '';
  return (
    ['42701', '42P07', 'ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(code || '') ||
    number === 1060 ||
    number === 1061 ||
    /duplicate column name|index .* already exists/i.test(message)
  );
}

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
  reviewService!: GitReviewService;
  legacyPostService!: LegacyPostService;

  async afterAdd() {
    this.reviewService = new GitReviewService(this.app);
    this.legacyPostService = new LegacyPostService(this.app);
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
        reviewLegacyPostStatus: reviewActions.reviewLegacyPostStatus,
        reviewLegacyRetryPost: reviewActions.reviewLegacyRetryPost,
        reviewLegacyReleaseHold: reviewActions.reviewLegacyReleaseHold,
        reviewReject: reviewActions.reviewReject,
        reviewWorkflowRetryPost: reviewActions.reviewWorkflowRetryPost,
        reviewCutoverStatus: reviewCutoverActions.reviewCutoverStatus,
        reviewConfirmCutover: reviewCutoverActions.reviewConfirmCutover,
        reviewCancelLegacy: reviewCutoverActions.reviewCancelLegacy,
        reviewRecover: reviewCutoverActions.reviewRecover,
        reviewResetPostClaim: reviewCutoverActions.reviewResetPostClaim,
        reviewCancelQueued: reviewCutoverActions.reviewCancelQueued,
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

    const legacyApprovalAction = this.app.acl.getAvailableAction('reviewApprovePost');
    const priorAliases = legacyApprovalAction?.options?.aliases;
    this.app.acl.setAvailableAction('reviewApprovePost', {
      ...legacyApprovalAction?.options,
      aliases: [
        ...(Array.isArray(priorAliases) ? priorAliases : priorAliases ? [priorAliases] : []),
        'reviewLegacyPostStatus',
        'reviewLegacyRetryPost',
      ],
    });

    // Existing repository permissions are stored on fileContent and triggerReview.
    // Aliases let the ACL apply those same grants and scopes to review controls.
    for (const [action, aliases] of [
      ['fileContent', ['reviewCutoverStatus']],
      [
        'triggerReview',
        [
          'reviewConfirmCutover',
          'reviewCancelLegacy',
          'reviewRecover',
          'reviewResetPostClaim',
          'reviewCancelQueued',
          'reviewLegacyReleaseHold',
        ],
      ],
    ] as const) {
      const registered = this.app.acl.getAvailableAction(action);
      const previous = registered?.options?.aliases;
      this.app.acl.setAvailableAction(action, {
        ...registered?.options,
        aliases: [...(Array.isArray(previous) ? previous : previous ? [previous] : []), ...aliases],
      });
    }

    for (const action of ['list', 'get', 'create', 'update', 'destroy'] as const) {
      this.app.acl.allow('gitReviewFlows', action, (ctx: Context) => {
        const roles = ctx.state?.currentRoles;
        if (!ctx.state?.currentUser?.id || !Array.isArray(roles)) return false;
        const gitAction = action === 'list' || action === 'get' ? 'fileContent' : 'triggerReview';
        return roles.some((role) => {
          if (typeof role !== 'string') return false;
          const collection = ctx.app.acl.getRole(role)?.getResource('gitReviewFlows');
          const permission = ctx.app.acl.can({ role, resource: 'gitReviewFlows', action });
          if (collection && !permission) return false;
          return Boolean(ctx.app.acl.can({ role, resource: 'gitManager', action: gitAction }));
        });
      });
    }

    this.app.resourceManager.use(enforceGitRequestMethod);
    this.app.resourceManager.use(enforceReviewControlAccess);
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

    registerGitReviewAiTools((this as any).app);

    (this as any).app.on('afterStart', async () => {
      await ensureAutoReviewFlowSchema((this as any).app).catch(
        (err) => (this as any).app.log?.error?.('plugin-git-manager: ensure schema error', err),
      );
      await this.ensureReviewSchema().catch(
        (error) => this.app.log?.error?.('plugin-git-manager: review schema error', error),
      );
      this.reviewService.start();
      subtreeActions
        .recoverStuckSubtreeRuns((this as any).app)
        .catch((err) => (this as any).app.log?.error?.('plugin-git-manager: recover subtree runs error', err));
      startPoller((this as any).app);
    });
    (this as any).app.on('beforeStop', () => {
      unregisterReviewQueue((this as any).app);
      this.reviewService.stop();
      stopPoller(this.app);
    });
    (this as any).app.on('beforeDestroy', () => {
      unregisterReviewQueue((this as any).app);
      this.reviewService.stop();
      stopPoller(this.app);
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
        'gitManager:reviewCutoverStatus',
        'workflowGitReview:status',
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
        'gitManager:reviewLegacyPostStatus',
        'gitManager:reviewLegacyRetryPost',
        'gitManager:reviewReject',
        'gitManager:reviewWorkflowRetryPost',
        'gitManager:pollNow',
        'gitSubtreeConfigs:create',
        'gitSubtreeConfigs:update',
        'gitSubtreeConfigs:destroy',
        'gitManager:subtreeRun',
        'gitManager:reviewConfirmCutover',
        'gitManager:reviewCancelLegacy',
        'gitManager:reviewRecover',
        'gitManager:reviewResetPostClaim',
        'gitManager:reviewCancelQueued',
        'gitManager:reviewLegacyReleaseHold',
        'workflowGitReview:setup',
        'workflowGitReview:repair',
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
    await (this as any).app.db.getCollection('gitReviewProjects')?.sync();
    await (this as any).app.db.getCollection('gitReviewInbox')?.sync();
    await (this as any).app.db.getCollection('gitReviewRequests')?.sync();
    await (this as any).app.db.getCollection('gitReviewCutover')?.sync();
    await this.ensureReviewSchema();
  }

  async ensureReviewSchema() {
    const lock = await this.app.lockManager.tryAcquire('git-manager-review-schema', 60_000);
    await lock.runExclusive(async () => {
      for (const name of ['gitReviewFlows', 'gitCodeReviews']) {
        const collection = this.db.getCollection(name);
        if (!collection) continue;
        for (let attempt = 0; ; attempt++) {
          try {
            await collection.model.sync({ alter: { drop: false } });
            break;
          } catch (error) {
            if (attempt >= 3 || !isConcurrentSchemaChange(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
      }
    }, 300_000);
  }

  async beforeDisable() {
    unregisterReviewQueue((this as any).app);
    this.reviewService.stop();
    stopPoller(this.app);
  }

  async beforeUnload() {
    unregisterReviewQueue((this as any).app);
    this.reviewService.stop();
    stopPoller(this.app);
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
