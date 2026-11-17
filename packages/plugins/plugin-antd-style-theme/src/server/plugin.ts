/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { InstallOptions, Plugin } from '@nocobase/server';
import type { StoredThemeConfig } from '../types';
import { ALL_BUILTIN_THEMES } from './builtinThemes';
import { updateTheme } from './actions/update-user-theme';
import themeConfigCollection from './collections/theme-config';

const THEME_EDITOR_NAMES = ['theme-editor', '@nocobase/plugin-theme-editor'];

export class PluginAntdStyleThemeServer extends Plugin {
  afterAdd() {}

  async beforeLoad() {}

  async loadCollections() {
    await super.loadCollections();
    if (!this.db.hasCollection('antdStyleThemeConfig')) {
      this.db.collection(themeConfigCollection);
    }
  }

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
      const message = err instanceof Error ? err.message : String(err);
      this.app.log.debug(`[antd-style-theme] Could not check theme-editor status: ${message}`);
    }
  }

  async ensureBuiltinThemes(options: { onlyWhenEmpty?: boolean } = {}) {
    const themeRepo = this.db.getRepository('antdStyleThemeConfig');
    if (!themeRepo) {
      return;
    }

    const totalCount = await themeRepo.count();
    if (options.onlyWhenEmpty && totalCount > 0) {
      return;
    }

    let hasDefault = (await themeRepo.count({ filter: { default: true } })) > 0;
    for (const item of ALL_BUILTIN_THEMES) {
      const existing = await themeRepo.findOne({ filter: { uid: item.uid } });
      if (!existing) {
        const shouldBeDefault = !hasDefault && Boolean(item.default);
        if (shouldBeDefault) {
          hasDefault = true;
        }
        try {
          await themeRepo.create({
            values: {
              ...item,
              default: shouldBeDefault,
            },
          });
        } catch (err) {
          if (err instanceof Error && err.name === 'SequelizeUniqueConstraintError') {
            continue;
          }
          throw err;
        }
      } else if (existing.get('isBuiltIn') && item.config?.token?.colorSettings) {
        const currentConfig = (existing.get('config') as StoredThemeConfig | null) || null;
        if (currentConfig && !currentConfig.token?.colorSettings) {
          await existing.update({
            config: {
              ...currentConfig,
              token: {
                ...currentConfig.token,
                colorSettings: item.config.token.colorSettings,
              },
            },
          });
        }
      }
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

    // Disable built-in theme-editor on startup and backfill built-in themes only on an empty table.
    this.app.on('afterStart', async () => {
      await this.disableBuiltinThemeEditor();
      await this.ensureBuiltinThemes({ onlyWhenEmpty: true });
    });
  }

  async install(options?: InstallOptions) {
    const themeRepo = this.db.getRepository('antdStyleThemeConfig');

    if (!themeRepo) {
      throw new Error(`antdStyleThemeConfig repository does not exist`);
    }

    await this.ensureBuiltinThemes({ onlyWhenEmpty: true });
  }

  async afterEnable() {
    // Disable theme-editor and ensure any newly shipped built-in templates exist on enable/upgrade.
    await this.disableBuiltinThemeEditor();
    await this.ensureBuiltinThemes();
  }

  async afterDisable() {}

  async remove() {}
}

export default PluginAntdStyleThemeServer;
