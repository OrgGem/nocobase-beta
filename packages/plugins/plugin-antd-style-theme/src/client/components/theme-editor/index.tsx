/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { css, cx } from '@emotion/css';
import { useApp, useGlobalTheme } from '@nocobase/client-v2';
import { createStyles } from '../../theme-compat';
import { error } from '@nocobase/utils/client';
import { Button, ConfigProvider, Input, Space, message } from 'antd';
import antdEnUs from 'antd/locale/en_US';
import antdZhCN from 'antd/locale/zh_CN';
import React, { useEffect } from 'react';
import { ThemeConfig } from '../../../types';
import { ThemeEditor, enUS, zhCN } from '../../antd-token-previewer';
import { useUpdateThemeSettings } from '../../hooks/useUpdateThemeSettings';
import { useTranslation } from '../../locale';
import { changeAlgorithmFromFunctionToString } from '../../utils/changeAlgorithmFromFunctionToString';
import { useThemeEditorContext } from '../ThemeEditorProvider';
import { useThemeListContext } from '../ThemeListProvider';

const useStyle = createStyles(({ token }) => ({
  editor: css({
    // ComponentDemoPro is now visible for component-level editing
  }),
  header: css({
    width: '100%',
    height: 56,
    padding: '0 16px',
    borderBottom: '1px solid #F0F0F0',
    backgroundColor: '#fff',

    '> .ant-space-item:first-child': {
      flex: 1,
    },
  }),

  errorPlaceholder: css({
    '&::placeholder': {
      color: token.colorErrorText,
    },
  }),
}));

const CustomTheme = ({ onThemeChange }: { onThemeChange?: (theme: ThemeConfig) => void }) => {
  const { styles } = useStyle();
  const {
    theme: globalTheme,
    setTheme: setGlobalTheme,
    getCurrentSettingTheme,
    setCurrentEditingTheme,
    getCurrentEditingTheme,
  } = useGlobalTheme();
  const [theme, setTheme] = React.useState<ThemeConfig>(globalTheme);
  const { setOpen } = useThemeEditorContext();
  const { t, i18n } = useTranslation();
  const { refresh } = useThemeListContext();
  const api = useApp().apiClient;
  const [themeName, setThemeName] = React.useState<string>(globalTheme.name);
  const [loading, setLoading] = React.useState(false);
  const { updateUserThemeSettings } = useUpdateThemeSettings();
  const [themeNameStatus, setThemeNameStatus] = React.useState<'' | 'error' | 'warning'>();

  useEffect(() => {
    setTheme(globalTheme);
  }, [globalTheme]);

  const lang = i18n.language;

  const handleSave = async () => {
    if (!themeName) {
      setThemeNameStatus('error');
      return;
    }

    setLoading(true);

    // 编辑主题
    if (getCurrentEditingTheme()) {
      const editingItem = getCurrentEditingTheme();
      editingItem.config = changeAlgorithmFromFunctionToString(theme) as any;
      editingItem.config.name = themeName;
      try {
        await api.request({
          url: `antdStyleThemeConfig:update/${editingItem.id}`,
          method: 'POST',
          data: editingItem,
        });
        refresh?.();
        message.success(t('Saved successfully'));
      } catch (err) {
        error(err);
      }
      setLoading(false);
      setOpen(false);
      setCurrentEditingTheme(null);
      setTheme(getCurrentSettingTheme());
      return;
    }

    // 新增主题
    try {
      const data = await api.request({
        url: 'antdStyleThemeConfig:create',
        method: 'POST',
        data: {
          config: {
            ...changeAlgorithmFromFunctionToString(theme),
            name: themeName,
          },
          optional: true,
          isBuiltIn: false,
        },
      });
      await updateUserThemeSettings(data.data.data.id);
      refresh?.();
      message.success(t('Saved successfully'));
    } catch (err) {
      error(err);
    }
    setLoading(false);
    setOpen(false);
  };

  const handleClose = () => {
    setOpen(false);
    setGlobalTheme(getCurrentSettingTheme());
    setCurrentEditingTheme(null);
  };

  const handleThemeNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) {
      setThemeNameStatus('error');
    } else {
      setThemeNameStatus('');
    }
    setThemeName(e.target.value);
  };

  return (
    <>
      <ConfigProvider theme={{ inherit: false }} locale={lang === 'zh-CN' ? antdZhCN : antdEnUs}>
        <Space className={styles.header}>
          <Input
            className={cx({ [styles.errorPlaceholder]: themeNameStatus === 'error' })}
            status={themeNameStatus}
            placeholder={t('Please set a name for this theme')}
            value={themeName}
            onChange={handleThemeNameChange}
            onPressEnter={handleSave}
          />
          <Button type="default" onClick={handleClose}>
            {t('Close')}
          </Button>
          <Button loading={loading} type="primary" onClick={handleSave}>
            {t('Save')}
          </Button>
        </Space>
        <ThemeEditor
          className={styles.editor}
          theme={{ name: 'Custom Theme', key: 'test', config: theme }}
          style={{ height: 'calc(100vh - 56px)', width: '100%' }}
          onThemeChange={(newTheme) => {
            setTheme(newTheme.config);
            onThemeChange?.(newTheme.config);
          }}
          locale={lang === 'zh-CN' ? zhCN : enUS}
        />
      </ConfigProvider>
    </>
  );
};

export default CustomTheme;
