import { Plugin } from '@nocobase/client';
import { WorkerMonitorLayout } from './WorkerMonitorLayout';

export class PluginWorkerMonitorClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('plugin-worker-monitor', {
      title: '{{t("Worker Monitor")}}',
      icon: 'DashboardOutlined',
      Component: WorkerMonitorLayout,
    });
  }
}

export default PluginWorkerMonitorClient;
