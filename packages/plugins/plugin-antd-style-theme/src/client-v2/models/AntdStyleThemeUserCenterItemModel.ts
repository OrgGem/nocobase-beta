// SPDX-License-Identifier: Apache-2.0

import { UserCenterSelectItemModel } from '@nocobase/client-v2';
import type { ThemeId } from '../../types';
import { getEffectiveTheme, getUserThemeId, listThemes, THEME_STORAGE_KEY, updateUserTheme } from '../themeApi';

export default class AntdStyleThemeUserCenterItemModel extends UserCenterSelectItemModel {
  static itemId = 'theme';
  section = 'preferences' as const;
  sort = 310;
  label = 'Theme';
  private themeIdMap = new Map<string, ThemeId>();

  async prepare() {
    const items = await listThemes(this.context.api);
    const selected = getEffectiveTheme(items, getUserThemeId(this.context.user));
    const optionalItems = items.filter((item) => item.optional && item.config);
    this.themeIdMap.clear();
    for (const item of optionalItems) {
      this.themeIdMap.set(String(item.id), item.id);
    }
    this.label = this.context.t('Theme', { ns: 'plugin-antd-style-theme' });
    this.options = optionalItems.map((item) => ({
      label: this.context.t(item.config?.name || '', { ns: 'plugin-antd-style-theme' }),
      value: String(item.id),
    }));
    this.value = selected ? String(selected.id) : undefined;
    this.ready = this.options.length > 0;
  }

  async onChange(value: string) {
    const rawId = this.themeIdMap.get(value);
    if (rawId === undefined) return;
    await updateUserTheme(this.context.api, rawId);
    this.context.api.auth.setOption(THEME_STORAGE_KEY, null);
    window.location.reload();
  }
}
