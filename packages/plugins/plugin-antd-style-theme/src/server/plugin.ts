/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { InstallOptions, Plugin } from '@nocobase/server';
import { businessPro, compact, compactDark, dark, defaultTheme, midnightEnterprise, vpbank, tweenOne } from './builtinThemes';
import { updateTheme } from './actions/update-user-theme';

const THEME_EDITOR_NAMES = ['theme-editor', '@nocobase/plugin-theme-editor'];

export class PluginAntdStyleThemeServer extends Plugin {
  theme: any;

  afterAdd() {}

  async beforeLoad() {}

  /**
   * Disable the built-in theme-editor plugin via direct DB update.
   * Uses direct repository update to avoid triggering a restart loop.
   */
  private async disableBuiltinThemeEditor() {
    try {
      const pluginRepo = this.db.getRepository('applicationPlugins');
      if (!pluginRepo) return;

      for (const name of THEME_EDITOR_NAMES) {
        const record = await pluginRepo.findOne({ filter: { name } });
        if (record && record.get('enabled')) {
          await pluginRepo.update({
            filter: { name },
            values: { enabled: false },
          });
          this.app.log.info(`[antd-style-theme] Disabled built-in plugin "${name}" to avoid conflicts.`);
        }
      }
    } catch (err) {
      // Silently ignore if applicationPlugins table doesn't exist yet (first install)
      this.app.log.debug(`[antd-style-theme] Could not check theme-editor status: ${err.message}`);
    }
  }

  async load() {
    this.app.resourceManager.registerActionHandler('users:updateAntdStyleTheme', updateTheme);
    this.app.acl.allow('users', 'updateAntdStyleTheme', 'loggedIn');

    this.app.acl.allow('antdStyleThemeConfig', 'list', 'public');
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.themes`,
      actions: ['antdStyleThemeConfig:*'],
    });

    // Disable built-in theme-editor on every startup
    this.app.on('afterStart', async () => {
      await this.disableBuiltinThemeEditor();

      // Ensure all built-in templates exist (handles upgrades with new templates)
      const themeRepo = this.db.getRepository('antdStyleThemeConfig');
      if (!themeRepo) return;

      const allBuiltins = [defaultTheme, dark, compact, compactDark, businessPro, midnightEnterprise, vpbank, tweenOne];
      for (const theme of allBuiltins) {
        const exists = await themeRepo.findOne({ filter: { uid: theme.uid } });
        if (!exists) {
          await themeRepo.create({ values: theme });
        }
      }
    });
  }

  async install(options?: InstallOptions) {
    const themeRepo = this.db.getRepository('antdStyleThemeConfig');

    if (!themeRepo) {
      throw new Error(`antdStyleThemeConfig repository does not exist`);
    }

    if ((await themeRepo.count()) === 0) {
      await themeRepo.create({
        values: [defaultTheme, dark, compact, compactDark, businessPro, midnightEnterprise, vpbank, tweenOne],
      });
    }
  }

  async afterEnable() {
    // Also disable theme-editor when this plugin is first enabled
    await this.disableBuiltinThemeEditor();
  }

  async afterDisable() {}

  async remove() {}
}

export default PluginAntdStyleThemeServer;
