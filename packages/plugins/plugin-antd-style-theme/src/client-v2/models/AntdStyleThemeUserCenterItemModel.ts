import { UserCenterSelectItemModel } from '@nocobase/client-v2';
import { getEffectiveTheme, getUserThemeId, listThemes, updateUserTheme } from '../themeApi';

export default class AntdStyleThemeUserCenterItemModel extends UserCenterSelectItemModel {
  static itemId = 'theme';
  section = 'preferences' as const;
  sort = 310;
  label = 'Theme';

  async prepare() {
    const items = await listThemes(this.context.api);
    const selected = getEffectiveTheme(items, getUserThemeId(this.context.user));
    this.label = this.context.t('Theme', { ns: 'plugin-antd-style-theme' });
    this.options = items
      .filter((item) => item.optional && item.config)
      .map((item) => ({
        label: this.context.t(item.config?.name || '', { ns: 'plugin-antd-style-theme' }),
        value: String(item.id),
      }));
    this.value = selected ? String(selected.id) : undefined;
    this.ready = this.options.length > 0;
  }

  async onChange(value: string) {
    if (!this.options.some((option) => option.value === value)) return;
    await updateUserTheme(this.context.api, value);
    window.location.reload();
  }
}
