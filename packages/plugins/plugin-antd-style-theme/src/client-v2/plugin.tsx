// SPDX-License-Identifier: Apache-2.0

import { Plugin, Application, Icon } from '@nocobase/client-v2';
import { IconPicker } from './components/IconPicker';
import { AntdStyleIconFieldModel } from './models/AntdStyleIconFieldModel';
import { installThemeRuntime } from './runtime/installThemeRuntime';

export class PluginAntdStyleThemeClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const aclSnippet = `pm.${this.options.name || 'plugin-antd-style-theme'}.themes`;
    const { extraIcons } = await import('../client/icons/extra-icons');
    Icon.register(extraIcons);
    this.app.addComponents({ IconPicker });
    this.flowEngine.flowSettings.registerComponents({ IconPicker });
    this.flowEngine.registerModels({ IconFieldModel: AntdStyleIconFieldModel });
    this.flowEngine.registerModelLoaders({
      AntdStyleThemeUserCenterItemModel: {
        extends: 'UserCenterItemModel',
        loader: () => import('./models/AntdStyleThemeUserCenterItemModel'),
      },
    });
    installThemeRuntime(this.app);
    this.pluginSettingsManager.addMenuItem({
      key: 'antd-style-theme',
      title: this.t('Antd Style Theme'),
      icon: 'BgColorsOutlined',
      aclSnippet,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'antd-style-theme',
      key: 'index',
      title: this.t('Antd Style Theme'),
      aclSnippet,
      componentLoader: () => import('../client/components/ThemeListPage'),
    });
  }
}

export default PluginAntdStyleThemeClient;
