import { Plugin } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';
import { WorkerMonitorLayout } from './WorkerMonitorLayout';

export class PluginWorkerMonitorClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('plugin-worker-monitor', {
      title: tval('Worker Monitor'),
      icon: 'DashboardOutlined',
      Component: WorkerMonitorLayout,
      aclSnippet: `pm.plugin-worker-monitor`,
    });
  }
}

export default PluginWorkerMonitorClient;
