import { Plugin } from '@nocobase/client';
import MemorySettingsPage from './components/MemorySettingsPage';

const SETTINGS_KEY = 'plugin-user-memory';
const SETTINGS_ACL = 'pm.user-memory.admin';

export class PluginUserMemoryClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      icon: 'BulbOutlined',
      title: this.t('User Memory'),
      Component: MemorySettingsPage,
      aclSnippet: SETTINGS_ACL,
    });
  }

  async remove() {
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
  }
}

export default PluginUserMemoryClient;
