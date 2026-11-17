/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { StablePopover } from '../../theme-compat';
import { Collapse, Input, InputNumber, Typography } from 'antd';
import classNames from 'classnames';
import type { FC } from 'react';
import React, { useCallback } from 'react';
import { useDebouncyFn } from 'use-debouncy';
import type { LoginThemeTokens, MutableTheme } from '../../../types';
import { useTranslation } from '../../locale';
import ColorPanel from '../ColorPanel';
import makeStyle from '../utils/makeStyle';

const { Panel } = Collapse;
const { Text } = Typography;

const useStyle = makeStyle('LoginStylePanel', (token) => ({
  '.login-style-panel': {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
    padding: '16px',

    '.login-style-panel-item': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: `1px solid ${token.colorBorderSecondary}`,

      '&:last-child': {
        borderBottom: 'none',
      },
    },

    '.login-style-panel-label': {
      flex: '1 1 auto',
      fontSize: 13,
      color: token.colorText,
    },

    '.login-style-panel-preview': {
      marginBottom: 16,
      borderRadius: token.borderRadiusLG,
      overflow: 'hidden',
      border: `1px solid ${token.colorBorderSecondary}`,
      height: 160,
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },

    '.login-style-panel-preview-card': {
      padding: '16px 24px',
      borderRadius: 8,
      textAlign: 'center',
      minWidth: 120,
      fontSize: 12,
    },
  },
}));

interface LoginTokenDef {
  key: keyof LoginThemeTokens;
  label: string;
  type: 'text' | 'color' | 'number';
}

// Login-specific custom tokens stored in theme.config.token
const loginTokens: Record<'appBranding' | 'background' | 'logo' | 'card' | 'button', LoginTokenDef[]> = {
  appBranding: [
    { key: 'appFavicon', label: 'Favicon URL', type: 'text' },
    { key: 'appTitle', label: 'App Title', type: 'text' },
  ],
  background: [
    { key: 'loginBgColor', label: 'Background Color', type: 'color' },
    { key: 'loginBgImage', label: 'Background Image URL', type: 'text' },
    { key: 'loginBgGradient', label: 'Background Gradient CSS', type: 'text' },
  ],
  logo: [
    { key: 'loginLogoUrl', label: 'Login Logo URL', type: 'text' },
    { key: 'loginLogoHeight', label: 'Logo Height (px)', type: 'number' },
  ],
  card: [
    { key: 'loginCardBg', label: 'Card Background', type: 'color' },
    { key: 'loginCardBorderRadius', label: 'Card Border Radius', type: 'number' },
    { key: 'loginCardShadow', label: 'Card Box Shadow', type: 'text' },
    { key: 'loginCardWidth', label: 'Card Width (px)', type: 'number' },
  ],
  button: [
    { key: 'loginBtnBg', label: 'Button Background', type: 'color' },
    { key: 'loginBtnBorderRadius', label: 'Button Border Radius', type: 'number' },
  ],
};

export type LoginStylePanelProps = {
  theme: MutableTheme;
  style?: React.CSSProperties;
};

const LoginStylePanel: FC<LoginStylePanelProps> = ({ theme, style }) => {
  const [wrapSSR, hashId] = useStyle();
  const { t } = useTranslation();

  const debouncedChange = useDebouncyFn((tokenKey: keyof LoginThemeTokens, value: string | number | null) => {
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

  const handleChange = useCallback(
    (tokenKey: keyof LoginThemeTokens, value: string | number | null) => {
      debouncedChange(tokenKey, value);
    },
    [debouncedChange],
  );

  const tokenRecord = (theme.config.token || {}) as Record<string, unknown>;
  const getString = (key: string): string => {
    const val = tokenRecord[key];
    return typeof val === 'string' ? val : '';
  };
  const getNumber = (key: string): number | undefined => {
    const val = tokenRecord[key];
    return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
  };

  const renderEditor = (item: LoginTokenDef) => {
    const label = t(item.label);

    if (item.type === 'color') {
      const value = getString(item.key);
      return (
        <div className="login-style-panel-item" key={item.key}>
          <span className="login-style-panel-label">{label}</span>
          <StablePopover
            trigger="click"
            placement="bottomRight"
            overlayInnerStyle={{ padding: 0 }}
            content={
              <ColorPanel
                color={value || '#ffffff'}
                onChange={(v) => handleChange(item.key, v)}
                style={{ border: 'none' }}
              />
            }
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
      );
    }

    if (item.type === 'number') {
      const value = getNumber(item.key);
      return (
        <div className="login-style-panel-item" key={item.key}>
          <span className="login-style-panel-label">{label}</span>
          <InputNumber
            size="small"
            aria-label={label}
            value={value}
            onChange={(val) => val !== null && handleChange(item.key, val)}
            style={{ width: 80 }}
            placeholder={t('auto')}
          />
        </div>
      );
    }

    const value = getString(item.key);
    return (
      <div className="login-style-panel-item" key={item.key}>
        <span className="login-style-panel-label">{label}</span>
        <Input
          size="small"
          aria-label={label}
          value={value}
          onChange={(e) => handleChange(item.key, e.target.value)}
          style={{ width: 200 }}
          placeholder={item.key.includes('Url') || item.key === 'appFavicon' ? 'https://...' : ''}
        />
      </div>
    );
  };

  // Mini preview
  const bgColor = getString('loginBgColor') || '#f0f2f5';
  const bgGradient = getString('loginBgGradient');
  const bgImage = getString('loginBgImage');
  const cardBg = getString('loginCardBg') || '#ffffff';
  const cardRadius = getNumber('loginCardBorderRadius') ?? 8;
  const cardShadow = getString('loginCardShadow') || '0 2px 8px rgba(0,0,0,0.15)';
  const logoUrl = getString('loginLogoUrl');
  const logoHeight = getNumber('loginLogoHeight') ?? 32;
  const btnBg = getString('loginBtnBg') || getString('colorPrimary') || '#1677ff';
  const btnRadius = getNumber('loginBtnBorderRadius') ?? 4;

  const previewBg: React.CSSProperties = {
    backgroundColor: bgColor,
    ...(bgGradient ? { background: bgGradient } : {}),
    ...(bgImage ? { backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
  };

  return wrapSSR(
    <div className={classNames(hashId, 'login-style-panel')} style={style}>
      {/* Live mini preview */}
      <div className="login-style-panel-preview" style={previewBg}>
        <div
          className="login-style-panel-preview-card"
          style={{
            backgroundColor: cardBg,
            borderRadius: cardRadius,
            boxShadow: cardShadow,
          }}
        >
          {logoUrl ? (
            <img
              src={logoUrl}
              style={{
                height: logoHeight,
                display: 'block',
                margin: '0 auto 8px',
              }}
              alt="logo"
            />
          ) : (
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#333' }}>{t('Logo')}</div>
          )}
          <div style={{ width: 80, height: 8, backgroundColor: '#e0e0e0', borderRadius: 4, marginBottom: 6 }} />
          <div style={{ width: 80, height: 8, backgroundColor: '#e0e0e0', borderRadius: 4, marginBottom: 8 }} />
          <div
            style={{
              width: 80,
              height: 20,
              backgroundColor: btnBg,
              borderRadius: btnRadius,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: '#fff',
            }}
          >
            {t('Sign In')}
          </div>
        </div>
      </div>

      <Collapse defaultActiveKey={['appBranding', 'background', 'logo', 'card', 'button']} ghost size="small">
        <Panel header={<span style={{ fontWeight: 600 }}>{t('🌐 App Branding')}</span>} key="appBranding">
          {loginTokens.appBranding.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{t('🖼️ Background')}</span>} key="background">
          {loginTokens.background.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{t('🏷️ Logo')}</span>} key="logo">
          {loginTokens.logo.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{t('🃏 Login Card')}</span>} key="card">
          {loginTokens.card.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{t('🔘 Button')}</span>} key="button">
          {loginTokens.button.map(renderEditor)}
        </Panel>
      </Collapse>
    </div>,
  );
};

export default LoginStylePanel;
