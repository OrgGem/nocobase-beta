import { Plugin } from '@nocobase/server';
import { tasksActions } from './actions/tasks';
import { workflowActions } from './actions/workflow-executions';
import { redisActions } from './actions/redis-monitor';
import { aclCacheActions, createAclCacheMiddleware } from './actions/acl-cache';

export class PluginWorkerMonitorServer extends Plugin {
  async load() {
    // Task management (reads asyncTasks table)
    this.app.resourcer.define({
      name: 'workerMonitor',
      actions: tasksActions,
    });

    // Workflow execution management (reads executions + jobs tables)
    this.app.resourcer.define({
      name: 'workerMonitorWorkflow',
      actions: workflowActions,
    });

    // Redis live metrics
    this.app.resourcer.define({
      name: 'workerMonitorRedis',
      actions: redisActions,
    });

    // ACL cache management
    this.app.resourcer.define({
      name: 'workerMonitorAclCache',
      actions: aclCacheActions,
    });

    // Install ACL cache middleware (caches acl.can() results in Redis)
    const aclCacheMiddleware = createAclCacheMiddleware(this.app);
    this.app.resourcer.use(aclCacheMiddleware, {
      tag: 'aclCache',
      before: 'acl',
      after: 'setCurrentRole',
    });

    // Admin-only access
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'workerMonitor:*',
        'workerMonitorWorkflow:*',
        'workerMonitorRedis:*',
        'workerMonitorAclCache:*',
      ],
    });
  }
}

export default PluginWorkerMonitorServer;
