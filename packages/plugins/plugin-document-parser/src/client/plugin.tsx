/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, lazy } from '@nocobase/client';
import { NAMESPACE } from './locale';

const { SettingsPage } = lazy(() => import('./components/SettingsPage'), 'SettingsPage');

export class PluginDocumentParserClient extends Plugin {
  async afterAdd() {
    // Register locale
    await this.app.i18n.changeLanguage(this.app.i18n.language);
  }

  async load() {
    // Add locale resources
    const locale = this.app.i18n.language || 'en-US';
    try {
      const messages = await import(`../locale/${locale}.json`).catch(() => import('../locale/en-US.json'));
      this.app.i18n.addResourceBundle(locale, NAMESPACE, messages.default || messages, true, true);
    } catch {
      // Locale file may not exist for this language — silently skip
    }

    // Register the settings page under Plugin Settings
    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: '{{t("Document Parser", { ns: "' + NAMESPACE + '" })}}',
      icon: 'FileTextOutlined',
      Component: SettingsPage,
      aclSnippet: 'pm.document-parser.settings',
    });
  }
}

export default PluginDocumentParserClient;
