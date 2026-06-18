import { Plugin, Application } from '@nocobase/client-v2';
import { NAMESPACE } from '../shared/constants';

/**
 * client-v2 lane. Registers the Carbone settings pages on the FlowEngine
 * runtime so the admin UI (templates / playground / cache / monitoring +
 * connection) is reachable when the app runs on the v2 client.
 *
 * The `carbone-render` workflow node-config UI is intentionally NOT registered
 * here: `@nocobase/plugin-workflow` has no client-v2 lane, so its instruction
 * UI continues to live in the v1 lane (`src/client/workflow`).
 */
export class PluginCarboneTemplateManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    // Settings keys cannot contain "." in the v2 settings manager, so use a
    // single menu with two page tabs.
    this.pluginSettingsManager.addMenuItem({
      key: 'carbone-template-manager',
      title: this.t('Carbone Template Manager'),
      icon: 'FileWordOutlined',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'carbone-template-manager',
      key: 'index',
      title: this.t('Settings'),
      aclSnippet: `pm.${NAMESPACE}.settings`,
      componentLoader: () => import('./components/SettingsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'carbone-template-manager',
      key: 'connection',
      title: this.t('Connection'),
      aclSnippet: `pm.${NAMESPACE}.connection`,
      componentLoader: () => import('./components/ConnectionSettings'),
    });
  }
}

export default PluginCarboneTemplateManagerClient;
