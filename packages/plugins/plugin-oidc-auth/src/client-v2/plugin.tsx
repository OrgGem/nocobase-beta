import { Plugin } from '@nocobase/client-v2';
import PluginAuthClientV2 from '@nocobase/plugin-auth/client-v2';
import { authType } from '../constants';

export class PluginOIDCClientV2 extends Plugin {
  async load() {
    const auth = this.app.pm.get(PluginAuthClientV2);
    auth.registerType(authType, {
      signInButtonLoader: () => import('./OIDCButton'),
      adminSettingsFormLoader: () => import('./OIDCAdminSettings'),
    });
  }
}

export default PluginOIDCClientV2;
