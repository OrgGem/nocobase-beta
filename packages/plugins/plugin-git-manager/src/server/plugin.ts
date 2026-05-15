import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { DataTypes } from 'sequelize';
import * as gitActions from './actions/git-actions';
import * as gitlabApi from './actions/gitlab-api';
import * as reviewActions from './actions/review';
import * as pollerActions from './actions/poller';
import { recoverStuckReviews, registerReviewQueue, unregisterReviewQueue } from './actions/review';
import { registerGitReviewAiTools } from './ai-tools';
import { startPoller, stopPoller } from './poller';

export class PluginGitManagerServer extends Plugin {
  // @ts-ignore
  declare app: any;
  // @ts-ignore
  declare db: any;
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
      },
    });

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
        'gitReviewFlows:list',
        'gitReviewFlows:get',
        'gitCodeReviews:list',
        'gitCodeReviews:get',
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
      ],
    });

    // Prevent overwriting PAT with obfuscated value on updates
    (this as any).app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName === 'gitRepositories' && ['create', 'update'].includes(ctx.action?.actionName)) {
        if (ctx.action.params?.values?.pat === '••••••••') {
          delete ctx.action.params.values.pat;
        }
        if (ctx.request.body?.pat === '••••••••') {
          delete ctx.request.body.pat;
        }
      }
      return next();
    });

    // Strip PAT from API responses — scoped to gitRepositories only
    (this as any).app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName !== 'gitRepositories') {
        return next();
      }
      await next();
      if (ctx.body) {
        const items = Array.isArray(ctx.body)
          ? ctx.body
          : ctx.body?.data
            ? Array.isArray(ctx.body.data)
              ? ctx.body.data
              : [ctx.body.data]
            : [ctx.body];
        items.forEach((item) => {
          if (item && typeof item === 'object') {
            if (item.pat) item.pat = '••••••••';
            if (item.dataValues?.pat) item.dataValues.pat = '••••••••';
          }
        });
      }
    });
  }

  async install() {
    await (this as any).app.db.getCollection('gitRepositories')?.sync();
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
  const tableName = `${tablePrefix}gitRepositories`;
  const tableInfo = await queryInterface.describeTable(tableName).catch(() => null);
  if (!tableInfo || tableInfo.autoReviewFlowId) return;

  await queryInterface.addColumn(tableName, 'autoReviewFlowId', {
    type: DataTypes.INTEGER,
    allowNull: true,
  });
}

export default PluginGitManagerServer;
