/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
import OidcClientsPage from './OidcClientsPage';

const SETTINGS_KEY = 'idp-oidc-client-manager';
const SETTINGS_ACL = 'pm.plugin-idp-oidc-client-manager.admin';

export class PluginIdpOidcClientManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      icon: 'SafetyCertificateOutlined',
      title: this.t('OIDC applications'),
      Component: OidcClientsPage,
      aclSnippet: SETTINGS_ACL,
    });
  }

  async remove() {
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
  }
}

export default PluginIdpOidcClientManagerClient;
