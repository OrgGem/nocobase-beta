/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { StablePopover } from '../../theme-compat';
import { Collapse, Typography } from 'antd';
import classNames from 'classnames';
import type { FC } from 'react';
import React, { useCallback } from 'react';
import { useDebouncyFn } from 'use-debouncy';
import { MutableTheme } from '../../../types';
import { useTranslation } from '../../locale';
import ColorPanel from '../ColorPanel';
import makeStyle from '../utils/makeStyle';

const { Panel } = Collapse;
const { Text } = Typography;

const useStyle = makeStyle('LayoutStylePanel', (token) => ({
  '.layout-style-panel': {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
    padding: '16px',

    '.layout-style-panel-item': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: `1px solid ${token.colorBorderSecondary}`,

      '&:last-child': {
        borderBottom: 'none',
      },
    },

    '.layout-style-panel-label': {
      flex: '1 1 auto',
      fontSize: 13,
      color: token.colorText,
    },

    '.layout-style-panel-value': {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
    },

    '.layout-style-panel-section-title': {
      fontSize: 13,
      fontWeight: 600,
      color: token.colorTextSecondary,
      marginBottom: 4,
      marginTop: 12,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
    },
  },
}));

interface ColorTokenEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

const ColorTokenEditor: FC<ColorTokenEditorProps> = ({ label, value, onChange }) => {
  return (
    <div className="layout-style-panel-item">
      <span className="layout-style-panel-label">{label}</span>
      <div className="layout-style-panel-value">
        <StablePopover
          trigger="click"
          placement="bottomRight"
          overlayInnerStyle={{ padding: 0 }}
          content={<ColorPanel color={value || '#ffffff'} onChange={onChange} style={{ border: 'none' }} />}
        >
          <button
            type="button"
            aria-label={label}
            style={{
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid #d9d9d9',
              borderRadius: 4,
              padding: '2px 8px',
              background: 'transparent',
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 2,
                backgroundColor: value || '#ffffff',
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)',
              }}
            />
            <Text style={{ fontSize: 12, fontFamily: 'Monaco, monospace' }}>{value || '—'}</Text>
          </button>
        </StablePopover>
      </div>
    </div>
  );
};

// NocoBase custom token keys for header and sider
const headerTokens = [
  { key: 'colorBgHeader', label: 'Header Background' },
  { key: 'colorPrimaryHeader', label: 'Header Primary Color' },
  { key: 'colorTextHeaderMenu', label: 'Menu Text' },
  { key: 'colorTextHeaderMenuHover', label: 'Menu Text (Hover)' },
  { key: 'colorTextHeaderMenuActive', label: 'Menu Text (Active)' },
  { key: 'colorBgHeaderMenuHover', label: 'Menu Background (Hover)' },
  { key: 'colorBgHeaderMenuActive', label: 'Menu Background (Active)' },
];

const siderTokens = [
  { key: 'colorBgSider', label: 'Sider Background' },
  { key: 'colorTextSiderMenu', label: 'Menu Text' },
  { key: 'colorTextSiderMenuHover', label: 'Menu Text (Hover)' },
  { key: 'colorTextSiderMenuActive', label: 'Menu Text (Active)' },
  { key: 'colorBgSiderMenuHover', label: 'Menu Background (Hover)' },
  { key: 'colorBgSiderMenuActive', label: 'Menu Background (Active)' },
];

export type LayoutStylePanelProps = {
  theme: MutableTheme;
  style?: React.CSSProperties;
};

const LayoutStylePanel: FC<LayoutStylePanelProps> = ({ theme, style }) => {
  const [wrapSSR, hashId] = useStyle();
  const { t } = useTranslation();

  const debouncedChange = useDebouncyFn((tokenKey: string, value: string) => {
    theme.onThemeChange?.(
      {
        ...theme.config,
        token: {
          ...(theme.config.token || {}),
          [tokenKey]: value,
        },
      },
      ['token', tokenKey],
    );
  }, 200);

  const handleTokenChange = useCallback(
    (tokenKey: string, value: string) => {
      debouncedChange(tokenKey, value);
    },
    [debouncedChange],
  );

  const getTokenValue = (key: string): string => {
    const tokenRecord = theme.config.token as Record<string, unknown> | undefined;
    const val = tokenRecord?.[key];
    return typeof val === 'string' ? val : '';
  };

  return wrapSSR(
    <div className={classNames(hashId, 'layout-style-panel')} style={style}>
      <Collapse defaultActiveKey={['header', 'sider']} ghost size="small">
        <Panel header={<span style={{ fontWeight: 600 }}>{t('🔝 Header / Navigation')}</span>} key="header">
          {headerTokens.map(({ key, label }) => (
            <ColorTokenEditor
              key={key}
              label={t(label)}
              value={getTokenValue(key)}
              onChange={(val) => handleTokenChange(key, val)}
            />
          ))}
        </Panel>

        <Panel header={<span style={{ fontWeight: 600 }}>{t('◀️ Sidebar / Sider Menu')}</span>} key="sider">
          {siderTokens.map(({ key, label }) => (
            <ColorTokenEditor
              key={key}
              label={t(label)}
              value={getTokenValue(key)}
              onChange={(val) => handleTokenChange(key, val)}
            />
          ))}
        </Panel>
      </Collapse>
    </div>,
  );
};

export default LayoutStylePanel;
