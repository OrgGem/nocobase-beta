/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { css, cx } from '@emotion/css';
import { defaultTheme, useApp, useGlobalTheme } from '@nocobase/client-v2';
import { createStyles } from '../../theme-compat';
import { error } from '@nocobase/utils/client';
import { Button, ConfigProvider, Input, Space, message } from 'antd';
import antdEnUs from 'antd/locale/en_US';
import antdViVN from 'antd/locale/vi_VN';
import antdZhCN from 'antd/locale/zh_CN';
import React, { useEffect } from 'react';
import {
  ANTD_STYLE_THEME_REFRESH_EVENT,
  isSameThemeId,
  normalizeTheme,
  serializeTheme,
  THEME_STORAGE_KEY,
  type ThemeItem,
} from '../../../client-v2/themeApi';
import type { ThemeConfig, ThemeId } from '../../../types';
import { ThemeEditor, enUS, zhCN } from '../../antd-token-previewer';
import { useUpdateThemeSettings } from '../../hooks/useUpdateThemeSettings';
import { useTranslation } from '../../locale';
import { changeAlgorithmFromFunctionToString } from '../../utils/changeAlgorithmFromFunctionToString';
import { useThemeId } from '../InitializeTheme';
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
    setCurrentSettingTheme,
    getCurrentSettingTheme,
    setCurrentEditingTheme,
    getCurrentEditingTheme,
  } = useGlobalTheme();
  const [theme, setTheme] = React.useState<ThemeConfig>(globalTheme);
  const { setOpen } = useThemeEditorContext();
  const { t, i18n } = useTranslation();
  const { refresh } = useThemeListContext();
  const { currentThemeId } = useThemeId();
  const api = useApp().apiClient;
  const editingItem = getCurrentEditingTheme() as unknown as ThemeItem | null;
  const editingKey = editingItem ? String(editingItem.id) : 'new';
  const [themeName, setThemeName] = React.useState<string>(editingItem?.config?.name ?? globalTheme?.name ?? '');
  const globalThemeNameRef = React.useRef(globalTheme?.name);
  globalThemeNameRef.current = globalTheme?.name;
  const [loading, setLoading] = React.useState(false);
  const { updateUserThemeSettings } = useUpdateThemeSettings();
  const [themeNameStatus, setThemeNameStatus] = React.useState<'' | 'error' | 'warning'>();

  useEffect(() => {
    setTheme(globalTheme);
  }, [globalTheme]);

  useEffect(() => {
    const currentEditing = getCurrentEditingTheme() as unknown as ThemeItem | null;
    setThemeName(currentEditing?.config?.name ?? globalThemeNameRef.current ?? '');
    setThemeNameStatus('');
  }, [editingKey, getCurrentEditingTheme]);

  const lang = i18n.language;

  const handleSave = async () => {
    if (!themeName) {
      setThemeNameStatus('error');
      return;
    }

    setLoading(true);

    const currentEditing = getCurrentEditingTheme() as unknown as ThemeItem | null;
    if (currentEditing) {
      const nextConfig = {
        ...changeAlgorithmFromFunctionToString(theme),
        name: themeName,
      };
      try {
        await api.request({
          url: `antdStyleThemeConfig:update/${currentEditing.id}`,
          method: 'POST',
          data: {
            config: nextConfig,
          },
        });
        if (isSameThemeId(currentEditing.id, currentThemeId)) {
          const normalized = normalizeTheme({ ...theme, name: themeName }, defaultTheme);
          setGlobalTheme(normalized);
          api.auth.setOption(THEME_STORAGE_KEY, serializeTheme({ ...currentEditing, config: normalized }));
        } else {
          setGlobalTheme(getCurrentSettingTheme() || defaultTheme);
        }
        window.dispatchEvent(new Event(ANTD_STYLE_THEME_REFRESH_EVENT));
        refresh?.();
        message.success(t('Saved successfully'));
        setCurrentSettingTheme(null);
        setCurrentEditingTheme(null as unknown as Parameters<typeof setCurrentEditingTheme>[0]);
        setOpen(false);
      } catch (err) {
        error(err);
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const data = await api.request<{ data: { id: ThemeId } }>({
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
      const createdId = data?.data?.data?.id ?? null;
      await updateUserThemeSettings(createdId);
      refresh?.();
      message.success(t('Saved successfully'));
      setCurrentSettingTheme(null);
      setCurrentEditingTheme(null as unknown as Parameters<typeof setCurrentEditingTheme>[0]);
      setOpen(false);
    } catch (err) {
      error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setGlobalTheme(getCurrentSettingTheme() || defaultTheme);
    setCurrentSettingTheme(null);
    setCurrentEditingTheme(null as unknown as Parameters<typeof setCurrentEditingTheme>[0]);
  };

  const handleThemeNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) {
      setThemeNameStatus('error');
    } else {
      setThemeNameStatus('');
    }
    setThemeName(e.target.value);
  };

  const antdLocale = lang === 'zh-CN' ? antdZhCN : lang === 'vi-VN' ? antdViVN : antdEnUs;

  return (
    <>
      <ConfigProvider theme={{ inherit: false }} locale={antdLocale}>
        <Space className={styles.header}>
          <Input
            className={cx({ [styles.errorPlaceholder]: themeNameStatus === 'error' })}
            status={themeNameStatus}
            placeholder={t('Please set a name for this theme')}
            aria-label={t('Please set a name for this theme')}
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
