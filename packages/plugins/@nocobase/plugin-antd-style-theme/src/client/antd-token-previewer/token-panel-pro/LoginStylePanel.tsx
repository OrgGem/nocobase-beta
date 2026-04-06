/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { StablePopover } from '@nocobase/client';
import { Collapse, Input, InputNumber, Typography } from 'antd';
import classNames from 'classnames';
import type { FC } from 'react';
import React, { useCallback } from 'react';
import { useDebouncyFn } from 'use-debouncy';
import { MutableTheme } from '../../../types';
import ColorPanel from '../ColorPanel';
import { useLocale } from '../locale';
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

// Login-specific custom tokens stored in theme.config.token
const loginTokens = {
  appBranding: [
    { key: 'appFavicon', label: 'Favicon URL', labelZh: 'Favicon URL', type: 'text' },
    { key: 'appTitle', label: 'App Title', labelZh: '应用标题', type: 'text' },
  ],
  background: [
    { key: 'loginBgColor', label: 'Background Color', labelZh: '背景颜色', type: 'color' },
    { key: 'loginBgImage', label: 'Background Image URL', labelZh: '背景图片 URL', type: 'text' },
    { key: 'loginBgGradient', label: 'Background Gradient CSS', labelZh: '渐变背景 CSS', type: 'text' },
  ],
  logo: [
    { key: 'loginLogoUrl', label: 'Login Logo URL', labelZh: '登录页 Logo URL', type: 'text' },
    { key: 'loginLogoHeight', label: 'Logo Height (px)', labelZh: 'Logo 高度 (px)', type: 'number' },
  ],
  card: [
    { key: 'loginCardBg', label: 'Card Background', labelZh: '卡片背景色', type: 'color' },
    { key: 'loginCardBorderRadius', label: 'Card Border Radius', labelZh: '卡片圆角', type: 'number' },
    { key: 'loginCardShadow', label: 'Card Box Shadow', labelZh: '卡片阴影', type: 'text' },
    { key: 'loginCardWidth', label: 'Card Width (px)', labelZh: '卡片宽度 (px)', type: 'number' },
  ],
  button: [
    { key: 'loginBtnBg', label: 'Button Background', labelZh: '按钮背景色', type: 'color' },
    { key: 'loginBtnBorderRadius', label: 'Button Border Radius', labelZh: '按钮圆角', type: 'number' },
  ],
};

export type LoginStylePanelProps = {
  theme: MutableTheme;
  style?: React.CSSProperties;
};

const LoginStylePanel: FC<LoginStylePanelProps> = ({ theme, style }) => {
  const [wrapSSR, hashId] = useStyle();
  const locale = useLocale();
  const isZh = locale._lang === 'zh-CN';

  const debouncedChange = useDebouncyFn((tokenKey: string, value: any) => {
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
    (tokenKey: string, value: any) => {
      debouncedChange(tokenKey, value);
    },
    [debouncedChange],
  );

  const getVal = (key: string): any => {
    return (theme.config.token as any)?.[key] ?? '';
  };

  const renderEditor = (item: { key: string; label: string; labelZh: string; type: string }) => {
    const label = isZh ? item.labelZh : item.label;
    const value = getVal(item.key);

    if (item.type === 'color') {
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
            <div
              style={{
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid #d9d9d9',
                borderRadius: 4,
                padding: '2px 8px',
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
            </div>
          </StablePopover>
        </div>
      );
    }

    if (item.type === 'number') {
      return (
        <div className="login-style-panel-item" key={item.key}>
          <span className="login-style-panel-label">{label}</span>
          <InputNumber
            size="small"
            value={value || undefined}
            onChange={(val) => val !== null && handleChange(item.key, val)}
            style={{ width: 80 }}
            placeholder="auto"
          />
        </div>
      );
    }

    // text
    return (
      <div className="login-style-panel-item" key={item.key}>
        <span className="login-style-panel-label">{label}</span>
        <Input
          size="small"
          value={value}
          onChange={(e) => handleChange(item.key, e.target.value)}
          style={{ width: 200 }}
          placeholder={item.key.includes('Url') ? 'https://...' : ''}
        />
      </div>
    );
  };

  // Mini preview
  const bgColor = getVal('loginBgColor') || '#f0f2f5';
  const bgGradient = getVal('loginBgGradient');
  const bgImage = getVal('loginBgImage');
  const cardBg = getVal('loginCardBg') || '#ffffff';
  const cardRadius = getVal('loginCardBorderRadius') || 8;
  const cardShadow = getVal('loginCardShadow') || '0 2px 8px rgba(0,0,0,0.15)';

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
          {getVal('loginLogoUrl') ? (
            <img
              src={getVal('loginLogoUrl')}
              style={{
                height: getVal('loginLogoHeight') || 32,
                marginBottom: 8,
                display: 'block',
                margin: '0 auto 8px',
              }}
              alt="logo"
            />
          ) : (
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#333' }}>Logo</div>
          )}
          <div style={{ width: 80, height: 8, backgroundColor: '#e0e0e0', borderRadius: 4, marginBottom: 6 }} />
          <div style={{ width: 80, height: 8, backgroundColor: '#e0e0e0', borderRadius: 4, marginBottom: 8 }} />
          <div
            style={{
              width: 80,
              height: 20,
              backgroundColor: getVal('loginBtnBg') || (theme.config.token as any)?.colorPrimary || '#1677ff',
              borderRadius: getVal('loginBtnBorderRadius') || 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: '#fff',
            }}
          >
            {isZh ? '登录' : 'Sign In'}
          </div>
        </div>
      </div>

      <Collapse defaultActiveKey={['appBranding', 'background', 'logo', 'card', 'button']} ghost size="small">
        <Panel
          header={<span style={{ fontWeight: 600 }}>{isZh ? '🌐 App Branding' : '🌐 App Branding'}</span>}
          key="appBranding"
        >
          {loginTokens.appBranding.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{isZh ? '🖼️ 背景' : '🖼️ Background'}</span>} key="background">
          {loginTokens.background.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{isZh ? '🏷️ Logo' : '🏷️ Logo'}</span>} key="logo">
          {loginTokens.logo.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{isZh ? '🃏 登录卡片' : '🃏 Login Card'}</span>} key="card">
          {loginTokens.card.map(renderEditor)}
        </Panel>
        <Panel header={<span style={{ fontWeight: 600 }}>{isZh ? '🔘 按钮' : '🔘 Button'}</span>} key="button">
          {loginTokens.button.map(renderEditor)}
        </Panel>
      </Collapse>
    </div>,
  );
};

export default LoginStylePanel;
