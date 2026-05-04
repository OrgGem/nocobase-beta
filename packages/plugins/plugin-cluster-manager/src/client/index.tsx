import { Plugin } from '@nocobase/client';
import { ClusterManagerLayout } from './ClusterManagerLayout';

export class PluginClusterManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('plugin-cluster-manager', {
      title: '{{t("Cluster Manager")}}',
      icon: 'DashboardOutlined',
      Component: ClusterManagerLayout,
    });
  }
}

export default PluginClusterManagerClient;
