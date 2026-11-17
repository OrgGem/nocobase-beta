/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { PlusOutlined } from '@ant-design/icons';
import { defaultTheme, useGlobalTheme } from '@nocobase/client-v2';
import { normalizeTheme } from '../../client-v2/themeApi';
import { useToken } from '../theme-compat';
import { App, Button, Space } from 'antd';
import React, { useCallback } from 'react';
import { useTranslation } from '../locale';
import { useThemeEditorContext } from './ThemeEditorProvider';

const ToEditTheme = () => {
  const { theme, setTheme, setCurrentSettingTheme, getCurrentSettingTheme, setCurrentEditingTheme } = useGlobalTheme();
  const { token } = useToken();
  const { setOpen } = useThemeEditorContext();
  const { t } = useTranslation();
  const { modal } = App.useApp();

  const handleClick = useCallback(() => {
    const m = modal.confirm({
      title: t('Add new theme'),
      closable: true,
      maskClosable: true,
      width: 'fit-content',
      footer: (
        <Space style={{ float: 'right', marginTop: token.margin, justifyContent: 'flex-end' }} wrap>
          <Button
            onClick={() => {
              if (!getCurrentSettingTheme()) {
                setCurrentSettingTheme(theme);
              }
              setCurrentEditingTheme(null as unknown as Parameters<typeof setCurrentEditingTheme>[0]);
              setTheme(normalizeTheme(theme, defaultTheme));
              setOpen(true);
              m.destroy();
            }}
          >
            {t('Edit based on current theme')}
          </Button>
          <Button
            type={'primary'}
            onClick={() => {
              if (!getCurrentSettingTheme()) {
                setCurrentSettingTheme(theme);
              }
              setCurrentEditingTheme(null as unknown as Parameters<typeof setCurrentEditingTheme>[0]);
              setTheme(normalizeTheme(defaultTheme, defaultTheme));
              setOpen(true);
              m.destroy();
            }}
          >
            {t('Create a brand new theme')}
          </Button>
        </Space>
      ),
    });
  }, [
    getCurrentSettingTheme,
    modal,
    setCurrentEditingTheme,
    setCurrentSettingTheme,
    setOpen,
    setTheme,
    t,
    theme,
    token.margin,
  ]);

  return (
    <Button
      type={'dashed'}
      style={{
        width: 240,
        height: 240,
        borderRadius: token.borderRadiusLG,
        borderColor: 'var(--colorSettings)',
        color: 'var(--colorSettings)',
      }}
      icon={<PlusOutlined />}
      onClick={handleClick}
    >
      {t('Add new theme')}
    </Button>
  );
};

ToEditTheme.displayName = 'ToEditTheme';

export default ToEditTheme;
