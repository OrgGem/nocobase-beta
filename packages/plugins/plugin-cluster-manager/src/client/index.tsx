import { Plugin } from '@nocobase/client';
import { ClusterManagerLayout } from './ClusterManagerLayout';
import { setupClientSafeCache } from './utils/clientSafeCache';
import { setupRequestDedupAndCache } from './utils/requestDedupInterceptor';

export class PluginClusterManagerClient extends Plugin {
  async load() {
    // Initialize safe sessionStorage clean-ups on role / token change
    setupClientSafeCache(this.app.apiClient);

    // Initialize in-flight request deduplication and safe storage
    setupRequestDedupAndCache(this.app.apiClient);

    this.app.pluginSettingsManager.add('plugin-cluster-manager', {
      title: '{{t("Cluster Manager")}}',
      icon: 'DashboardOutlined',
      Component: ClusterManagerLayout,
    });
  }
}

export default PluginClusterManagerClient;
