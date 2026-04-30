import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import * as gitActions from './actions/git-actions';
import * as gitlabApi from './actions/gitlab-api';
import * as reviewActions from './actions/review';
import * as pollerActions from './actions/poller';
import { registerGitReviewAiTools } from './ai-tools';
import { startPoller, stopPoller } from './poller';

export class PluginGitManagerServer extends Plugin {
  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.app.resourceManager.define({
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

    registerGitReviewAiTools(this.app);
    startPoller(this.app);

    // Read-only operations available to all plugin users
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.read`,
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
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.write`,
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

    // Strip PAT from API responses — scoped to gitRepositories only
    this.app.resourceManager.use(async (ctx, next) => {
      if (ctx.action?.resourceName !== 'gitRepositories') {
        return next();
      }
      await next();
      if (ctx.body) {
        const items = Array.isArray(ctx.body) ? ctx.body : ctx.body?.data ? (Array.isArray(ctx.body.data) ? ctx.body.data : [ctx.body.data]) : [ctx.body];
        items.forEach((item) => {
          if (item && typeof item === 'object') {
            if (item.pat) item.pat = '••••••••';
            if (item.dataValues?.pat) item.dataValues.pat = '••••••••';
          }
        });
      }
    });
  }

  async install() {}

  async beforeDisable() {
    stopPoller();
  }

  async beforeUnload() {
    stopPoller();
  }
}

export default PluginGitManagerServer;
