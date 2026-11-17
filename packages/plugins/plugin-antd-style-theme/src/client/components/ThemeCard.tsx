/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DeleteOutlined, EditOutlined, EllipsisOutlined } from '@ant-design/icons';
import { defaultTheme, useApp, useCurrentUserContext, useGlobalTheme } from '@nocobase/client-v2';
import { useToken } from '../theme-compat';
import { error } from '@nocobase/utils/client';
import { App, Button, Card, ConfigProvider, Dropdown, Space, Switch, Tag, message } from 'antd';
import React, { useCallback, useMemo } from 'react';
import { getUserThemeId, isSameThemeId, normalizeTheme, type ThemeItem } from '../../client-v2/themeApi';
import type { ThemeConfig } from '../../types';
import { Primary } from '../antd-token-previewer';
import { useUpdateThemeSettings } from '../hooks/useUpdateThemeSettings';
import { useTranslation } from '../locale';
import { useThemeId } from './InitializeTheme';
import { useThemeEditorContext } from './ThemeEditorProvider';

enum HandleTypes {
  delete = 'delete',
  optional = 'optional',
}

interface Props {
  item: ThemeItem;
  style?: React.CSSProperties;
  onChange?: (params: { type: HandleTypes; item: ThemeItem }) => void;
}

const Overview = ({ theme }: { theme: ThemeConfig }) => {
  const { token } = useToken();

  return (
    <ConfigProvider theme={{ ...theme, inherit: false }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          pointerEvents: 'none',
          width: '100%',
          height: 129,
          borderRadius: token.borderRadiusLG,
          overflow: 'hidden',
        }}
      >
        <Space
          style={{
            transform: 'scale(0.7) translate(0, 0)',
            transformOrigin: '0 0',
          }}
          size={0}
          align="start"
        >
          <Primary />
        </Space>
      </div>
    </ConfigProvider>
  );
};

const ThemeCard = (props: Props) => {
  const {
    theme: currentTheme,
    setTheme,
    setCurrentSettingTheme,
    getCurrentSettingTheme,
    setCurrentEditingTheme,
    getCurrentEditingTheme,
  } = useGlobalTheme();
  const { setOpen } = useThemeEditorContext();
  const currentUser = useCurrentUserContext();
  const { item, style = {}, onChange } = props;
  const api = useApp().apiClient;
  const { updateUserThemeSettings } = useUpdateThemeSettings();
  const { modal } = App.useApp();
  const [loading, setLoading] = React.useState(false);
  const { currentThemeId, defaultThemeId } = useThemeId();
  const { t } = useTranslation();
  const { token } = useToken();

  const isDefault = isSameThemeId(item.id, defaultThemeId);
  const userThemeId = getUserThemeId(currentUser?.data?.data);

  const handleDelete = useCallback(() => {
    if (isDefault) {
      return;
    }

    modal.confirm({
      title: t('Delete theme'),
      content: t('Deletion is unrecoverable. Confirm deletion?'),
      onOk: async () => {
        await api.request({
          url: `antdStyleThemeConfig:destroy/${item.id}`,
        });

        if (isSameThemeId(item.id, userThemeId)) {
          await updateUserThemeSettings(null);
        }
        message.success(t('Deleted successfully'));
        onChange?.({ type: HandleTypes.delete, item });
      },
    });
  }, [api, isDefault, item, modal, onChange, t, updateUserThemeSettings, userThemeId]);

  const handleSwitchOptional = useCallback(
    async (checked: boolean) => {
      setLoading(true);
      try {
        if (!checked) {
          await api.request({
            url: `antdStyleThemeConfig:update/${item.id}`,
            method: 'post',
            data: {
              optional: checked,
              default: false,
            },
          });
          if (isSameThemeId(item.id, userThemeId)) {
            await updateUserThemeSettings(null);
          }
        } else {
          await api.request({
            url: `antdStyleThemeConfig:update/${item.id}`,
            method: 'post',
            data: {
              optional: checked,
            },
          });
        }
        message.success(t('Updated successfully'));
        onChange?.({ type: HandleTypes.optional, item });
      } catch (err) {
        error(err);
      } finally {
        setLoading(false);
      }
    },
    [api, item, onChange, t, updateUserThemeSettings, userThemeId],
  );

  const handleSwitchDefault = useCallback(
    async (checked: boolean) => {
      setLoading(true);
      try {
        if (checked) {
          await api.request({
            url: `antdStyleThemeConfig:update/${item.id}`,
            method: 'post',
            data: {
              optional: true,
              default: true,
            },
          });
        } else {
          await api.request({
            url: `antdStyleThemeConfig:update/${item.id}`,
            method: 'post',
            data: {
              default: false,
            },
          });
        }
        message.success(t('Updated successfully'));
        onChange?.({ type: HandleTypes.optional, item });
      } catch (err) {
        error(err);
      } finally {
        setLoading(false);
      }
    },
    [api, item, onChange, t],
  );

  const handleEdit = useCallback(() => {
    if (!getCurrentSettingTheme()) {
      setCurrentSettingTheme(currentTheme);
    }
    setCurrentEditingTheme(item as unknown as Parameters<typeof setCurrentEditingTheme>[0]);
    setTheme(normalizeTheme(item.config, defaultTheme));
    setOpen(true);
  }, [currentTheme, getCurrentSettingTheme, item, setCurrentEditingTheme, setCurrentSettingTheme, setOpen, setTheme]);

  const menu = useMemo(() => {
    return {
      items: [
        {
          key: 'optional',
          label: (
            <Space
              style={{ width: '100%', justifyContent: 'space-between' }}
              align="center"
              size="middle"
              onClick={(e) => e.stopPropagation()}
            >
              <span>{t('User selectable')}</span>
              <Switch
                disabled={isDefault}
                style={{ transform: 'translateY(-2px)' }}
                checked={Boolean(item.optional)}
                size="small"
                loading={loading}
                onChange={handleSwitchOptional}
              />
            </Space>
          ),
        },
        {
          key: 'system',
          label: (
            <Space
              style={{ width: '100%', justifyContent: 'space-between' }}
              align="center"
              size="middle"
              onClick={(e) => e.stopPropagation()}
            >
              <span>{t('Default theme')}</span>
              <Switch
                disabled={isDefault}
                style={{ transform: 'translateY(-2px)' }}
                checked={isDefault}
                size="small"
                loading={loading}
                onChange={handleSwitchDefault}
              />
            </Space>
          ),
        },
      ],
    };
  }, [handleSwitchDefault, handleSwitchOptional, isDefault, item.optional, loading, t]);

  const actions = useMemo(() => {
    return [
      <Button
        key="edit"
        type="text"
        size="small"
        aria-label={t('Edit')}
        icon={<EditOutlined />}
        onClick={handleEdit}
      />,
      <Button
        key="delete"
        type="text"
        size="small"
        disabled={isDefault}
        aria-label={t('Delete theme')}
        icon={<DeleteOutlined />}
        onClick={handleDelete}
      />,
      <Dropdown key="ellipsis" menu={menu}>
        <Button type="text" size="small" aria-label={t('Theme settings')} icon={<EllipsisOutlined />} />
      </Dropdown>,
    ];
  }, [handleDelete, handleEdit, isDefault, menu, t]);

  const extra = useMemo(() => {
    if (!isDefault && !item.optional) {
      return null;
    }
    const isCurrent = isSameThemeId(item.id, currentThemeId);
    const text = isCurrent
      ? t('Current')
      : isDefault
        ? t('Default')
        : item.optional
          ? t('Optional')
          : t('Non-optional');
    const color = isCurrent ? 'processing' : isDefault ? 'default' : item.optional ? 'success' : 'error';

    return (
      <Tag style={{ marginRight: 0 }} color={color}>
        {text}
      </Tag>
    );
  }, [currentThemeId, isDefault, item.id, item.optional, t]);

  const cardStyle = useMemo(() => {
    if (isSameThemeId(getCurrentEditingTheme()?.id, item.id)) {
      return {
        cursor: 'default',
        width: 240,
        height: 240,
        overflow: 'hidden',
        outline: '1px solid var(--colorSettings)',
        ...style,
      };
    }
    return { cursor: 'default', width: 240, height: 240, overflow: 'hidden', ...style };
  }, [getCurrentEditingTheme, item.id, style]);

  return (
    <Card
      hoverable
      extra={extra}
      title={t(item.config?.name || '')}
      size="small"
      style={cardStyle}
      styles={{ header: { minHeight: 38 } }}
      actions={actions}
    >
      <Overview theme={item.config || defaultTheme} />
    </Card>
  );
};

ThemeCard.displayName = 'ThemeCard';

export default ThemeCard;
