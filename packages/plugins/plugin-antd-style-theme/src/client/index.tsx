/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Icon, Plugin, createStyles, defaultTheme, useGlobalTheme } from '@nocobase/client';
import { ConfigProvider } from 'antd';
import _ from 'lodash';
import React, { useMemo } from 'react';
// import InitializeTheme from './components/InitializeTheme';
// import { ThemeEditorProvider } from './components/ThemeEditorProvider';
// import ThemeList from './components/ThemeList';
// import { ThemeListProvider } from './components/ThemeListProvider';
// import CustomTheme from './components/theme-editor';
import { lazy } from '@nocobase/client';
const InitializeTheme = lazy(() => import('./components/InitializeTheme'));
const { ThemeEditorProvider } = lazy(() => import('./components/ThemeEditorProvider'), 'ThemeEditorProvider');
const ThemeList = lazy(() => import('./components/ThemeList'));
const { ThemeListProvider } = lazy(() => import('./components/ThemeListProvider'), 'ThemeListProvider');
const CustomTheme = lazy(() => import('./components/theme-editor'));
const LoginThemeProvider = lazy(() => import('./components/LoginThemeProvider'));

import { ThemeSettings } from './components/ThemeSettings';
import { NAMESPACE } from './locale';

const useStyles = createStyles(({ css, token }) => {
  return {
    editor: css`
      overflow: hidden;
      border-left: 1px solid ${token.colorBorderSecondary};
      animation: 0.1s ease-out 0s 1 slideInFromRight;
      @keyframes slideInFromRight {
        0% {
          transform: translateX(100%);
        }
        100% {
          transform: translateX(0);
        }
      }
    `,
  };
});

const CustomThemeProvider = React.memo((props: React.PropsWithChildren) => {
  const [open, setOpen] = React.useState(false);
  const { theme, setTheme } = useGlobalTheme();
  const { styles } = useStyles();

  const contentStyle = useMemo(() => {
    return open
      ? { transform: 'rotate(0)', flexGrow: 1, width: 0, height: '100%' }
      : { flexGrow: 1, width: 0, height: '100%' };
  }, [open]);

  const editor = (
    <div style={{ display: 'flex', overflow: 'hidden', height: '100%' }}>
      <div style={contentStyle}>{props.children}</div>
      {open ? (
        <div className={styles.editor}>
          <CustomTheme onThemeChange={setTheme} />
        </div>
      ) : null}
    </div>
  );

  if (!theme?.token?.motionUnit) {
    _.set(theme, 'token.motionUnit', defaultTheme.token.motionUnit);
  }

  return (
    <ConfigProvider theme={theme}>
      <LoginThemeProvider>
        <ThemeListProvider>
          <InitializeTheme>
            <ThemeEditorProvider open={open} setOpen={setOpen}>
              {editor}
            </ThemeEditorProvider>
          </InitializeTheme>
        </ThemeListProvider>
      </LoginThemeProvider>
    </ConfigProvider>
  );
});
CustomThemeProvider.displayName = 'CustomThemeProvider';

export class PluginAntdStyleThemeClient extends Plugin {
  async load() {
    // Register extra icons AND override IconPicker synchronously
    // to ensure they're available before any component renders
    const { extraIcons } = await import('./icons/extra-icons');
    Icon.register(extraIcons);

    const { IconPicker } = await import('./components/EnhancedIconPicker');
    this.app.addComponents({ IconPicker: IconPicker as any });

    // Override core Input with IME-safe version to fix Vietnamese/CJK composition
    // 1. Schema/Formily path: override the Input component
    // const { IMESafeInput } = await import('./components/IMESafeInput');
    // this.app.addComponents({ Input: IMESafeInput as any });

    // const { IMESafeInputFieldModel } = await import('./models/IMESafeInputFieldModel');
    // this.flowEngine.registerModels({ InputFieldModel: IMESafeInputFieldModel as any });

    this.app.use(CustomThemeProvider);
    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: `{{t("Antd Style Theme", {ns:"${NAMESPACE}"})}}`,
      icon: 'BgColorsOutlined',
      Component: ThemeList,
      aclSnippet: 'pm.antd-style-theme.themes',
    });
    // 个人中心注册 Theme 菜单项
    this.app.addUserCenterSettingsItem({
      name: 'theme',
      sort: 310,
      Component: ThemeSettings,
    });
  }
}

export default PluginAntdStyleThemeClient;
