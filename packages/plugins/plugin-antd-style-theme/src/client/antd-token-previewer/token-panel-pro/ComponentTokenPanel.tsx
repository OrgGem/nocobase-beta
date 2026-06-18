/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { StablePopover } from '../../theme-compat';
import { Button, Collapse, ConfigProvider, Empty, Input, InputNumber, Select, Space, Tooltip, Typography } from 'antd';
import classNames from 'classnames';
import type { FC } from 'react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDebouncyFn } from 'use-debouncy';
import { MutableTheme } from '../../../types';
import ColorPanel from '../ColorPanel';
import ComponentDemos from '../component-demos';
import { antdComponents } from '../component-panel';
import { useLocale } from '../locale';
import makeStyle from '../utils/makeStyle';
import { getComponentToken } from '../utils/statistic';
import tokenMeta from './token-meta.json';

const { Panel } = Collapse;
const { Text } = Typography;

const useStyle = makeStyle('ComponentTokenPanel', (token) => ({
  '.component-token-panel': {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',

    '.component-token-panel-header': {
      padding: '16px 16px 8px',
      flex: 'none',
    },

    '.component-token-panel-content': {
      flex: 1,
      overflow: 'auto',
      padding: '0 16px 16px',
    },

    '.component-token-panel-token-item': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '6px 0',
      borderBottom: `1px solid ${token.colorBorderSecondary}`,
      gap: 8,

      '&:last-child': {
        borderBottom: 'none',
      },

      '.component-token-panel-token-name': {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },

      '.component-token-panel-token-value': {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      },
    },

    '.component-token-panel-preview': {
      borderRadius: token.borderRadius,
      border: `1px solid ${token.colorBorderSecondary}`,
      padding: 16,
      marginBottom: 12,
      backgroundColor: token.colorBgContainer,
    },
  },
}));

// Build a flat list of all component names from antdComponents mapping
const allComponentNames = Object.values(antdComponents).flat().sort();

const isColorToken = (tokenName: string): boolean => {
  const lower = tokenName.toLowerCase();
  return (
    lower.includes('color') ||
    lower.includes('bg') ||
    (lower.includes('border') && !lower.includes('radius') && !lower.includes('width')) ||
    lower.endsWith('shadow')
  );
};

const isNumberToken = (tokenName: string, value: any): boolean => {
  if (typeof value === 'number') return true;
  const lower = tokenName.toLowerCase();
  return (
    lower.includes('size') ||
    lower.includes('width') ||
    lower.includes('height') ||
    lower.includes('radius') ||
    lower.includes('margin') ||
    lower.includes('padding') ||
    lower.includes('fontsize') ||
    lower.includes('lineheight') ||
    lower.includes('zindex')
  );
};

type TokenEditorProps = {
  tokenName: string;
  value: any;
  defaultValue: any;
  onChange: (value: any) => void;
  onReset: () => void;
  isModified: boolean;
};

const TokenEditor: FC<TokenEditorProps> = ({ tokenName, value, defaultValue, onChange, onReset, isModified }) => {
  const displayValue = value ?? defaultValue;

  if (isColorToken(tokenName) && typeof displayValue === 'string') {
    return (
      <div className="component-token-panel-token-value">
        {isModified && (
          <Typography.Link style={{ fontSize: 12 }} onClick={onReset}>
            Reset
          </Typography.Link>
        )}
        <StablePopover
          trigger="click"
          placement="bottomRight"
          overlayInnerStyle={{ padding: 0 }}
          content={<ColorPanel color={displayValue} onChange={onChange} style={{ border: 'none' }} />}
        >
          <div
            style={{
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${isModified ? '#1677ff' : '#d9d9d9'}`,
              borderRadius: 4,
              padding: '2px 8px',
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 2,
                backgroundColor: displayValue,
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)',
              }}
            />
            <Text style={{ fontSize: 12, fontFamily: 'Monaco, monospace' }}>{displayValue}</Text>
          </div>
        </StablePopover>
      </div>
    );
  }

  if (isNumberToken(tokenName, displayValue)) {
    return (
      <div className="component-token-panel-token-value">
        {isModified && (
          <Typography.Link style={{ fontSize: 12 }} onClick={onReset}>
            Reset
          </Typography.Link>
        )}
        <InputNumber
          size="small"
          value={displayValue}
          onChange={(val) => val !== null && onChange(val)}
          style={{ width: 80, borderColor: isModified ? '#1677ff' : undefined }}
        />
      </div>
    );
  }

  return (
    <div className="component-token-panel-token-value">
      {isModified && (
        <Typography.Link style={{ fontSize: 12 }} onClick={onReset}>
          Reset
        </Typography.Link>
      )}
      <Input
        size="small"
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 120, borderColor: isModified ? '#1677ff' : undefined }}
      />
    </div>
  );
};

export type ComponentTokenPanelProps = {
  theme: MutableTheme;
  style?: React.CSSProperties;
};

const ComponentTokenPanel: FC<ComponentTokenPanelProps> = ({ theme, style }) => {
  const [wrapSSR, hashId] = useStyle();
  const [selectedComponent, setSelectedComponent] = useState<string>('Menu');
  const [searchText, setSearchText] = useState('');
  const locale = useLocale();

  // Get component token info from antd's token.json
  const componentTokenInfo = useMemo(() => {
    return getComponentToken(selectedComponent);
  }, [selectedComponent]);

  const componentTokens = useMemo(() => {
    if (!componentTokenInfo?.component) return {};
    return componentTokenInfo.component;
  }, [componentTokenInfo]);

  // Get current theme config for this component
  const currentComponentConfig = useMemo(() => {
    return (theme.config.components as any)?.[selectedComponent] || {};
  }, [theme.config.components, selectedComponent]);

  // Filtered token list based on search
  const filteredTokens = useMemo(() => {
    const tokens = Object.keys(componentTokens);
    if (!searchText) return tokens;
    return tokens.filter((t) => t.toLowerCase().includes(searchText.toLowerCase()));
  }, [componentTokens, searchText]);

  // Categorize tokens
  const categorizedTokens = useMemo(() => {
    const categories: Record<string, string[]> = {
      Colors: [],
      'Sizes & Spacing': [],
      Other: [],
    };

    filteredTokens.forEach((tokenName) => {
      if (isColorToken(tokenName)) {
        categories['Colors'].push(tokenName);
      } else if (isNumberToken(tokenName, componentTokens[tokenName])) {
        categories['Sizes & Spacing'].push(tokenName);
      } else {
        categories['Other'].push(tokenName);
      }
    });

    return Object.entries(categories).filter(([, tokens]) => tokens.length > 0);
  }, [filteredTokens, componentTokens]);

  const debouncedOnChange = useDebouncyFn((component: string, tokenName: string, value: any) => {
    theme.onThemeChange?.(
      {
        ...theme.config,
        components: {
          ...(theme.config.components || {}),
          [component]: {
            ...((theme.config.components as any)?.[component] || {}),
            [tokenName]: value,
          },
        },
      },
      ['components', component, tokenName],
    );
  }, 300);

  const handleTokenChange = useCallback(
    (tokenName: string, value: any) => {
      debouncedOnChange(selectedComponent, tokenName, value);
    },
    [selectedComponent, debouncedOnChange],
  );

  const handleTokenReset = useCallback(
    (tokenName: string) => {
      const currentConfig = (theme.config.components as any)?.[selectedComponent] || {};
      const newConfig = { ...currentConfig };
      delete newConfig[tokenName];
      theme.onThemeChange?.(
        {
          ...theme.config,
          components: {
            ...(theme.config.components || {}),
            [selectedComponent]: Object.keys(newConfig).length > 0 ? newConfig : undefined,
          },
        },
        ['components', selectedComponent, tokenName],
      );
    },
    [selectedComponent, theme],
  );

  // Count modified tokens
  const modifiedCount = Object.keys(currentComponentConfig).length;

  // Reset all tokens for current component
  const handleResetAll = useCallback(() => {
    const newComponents = { ...(theme.config.components || {}) };
    delete (newComponents as any)[selectedComponent];
    theme.onThemeChange?.(
      {
        ...theme.config,
        components: newComponents,
      },
      ['components', selectedComponent],
    );
  }, [selectedComponent, theme]);

  return wrapSSR(
    <div className={classNames(hashId, 'component-token-panel')} style={style}>
      <div className="component-token-panel-header">
        <Select
          showSearch
          style={{ width: '100%', marginBottom: 8 }}
          value={selectedComponent}
          onChange={setSelectedComponent}
          options={allComponentNames.map((name) => ({
            label: name,
            value: name,
          }))}
          placeholder="Select Component"
          filterOption={(input, option) => (option?.label as string)?.toLowerCase().includes(input.toLowerCase())}
        />
        <Input
          size="small"
          placeholder={locale._lang === 'zh-CN' ? '搜索 Token...' : 'Search tokens...'}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ marginBottom: 8 }}
        />
        {modifiedCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {modifiedCount} token(s) modified
            </Text>
            <Typography.Link style={{ fontSize: 12 }} onClick={handleResetAll}>
              Reset All
            </Typography.Link>
          </div>
        )}
      </div>

      <div className="component-token-panel-content">
        {/* Component Preview */}
        {ComponentDemos[selectedComponent] && (
          <div className="component-token-panel-preview">
            <ConfigProvider theme={theme.config}>{ComponentDemos[selectedComponent]?.[0]?.demo}</ConfigProvider>
          </div>
        )}

        {categorizedTokens.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={searchText ? 'No matching tokens' : 'No component tokens available'}
          />
        ) : (
          <Collapse defaultActiveKey={categorizedTokens.map(([key]) => key)} ghost size="small">
            {categorizedTokens.map(([category, tokens]) => (
              <Panel
                header={
                  <span style={{ fontWeight: 500 }}>
                    {category} ({tokens.length})
                  </span>
                }
                key={category}
              >
                {tokens.map((tokenName) => {
                  const defaultValue = componentTokens[tokenName];
                  const isModified = tokenName in currentComponentConfig;
                  const currentValue = isModified ? currentComponentConfig[tokenName] : undefined;

                  return (
                    <div className="component-token-panel-token-item" key={tokenName}>
                      <Tooltip title={tokenName} placement="left">
                        <div className="component-token-panel-token-name">
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: isModified ? 600 : 'normal',
                              color: isModified ? '#1677ff' : undefined,
                            }}
                          >
                            {tokenName}
                          </Text>
                        </div>
                      </Tooltip>
                      <TokenEditor
                        tokenName={tokenName}
                        value={currentValue}
                        defaultValue={defaultValue}
                        onChange={(val) => handleTokenChange(tokenName, val)}
                        onReset={() => handleTokenReset(tokenName)}
                        isModified={isModified}
                      />
                    </div>
                  );
                })}
              </Panel>
            ))}
          </Collapse>
        )}
      </div>
    </div>,
  );
};

export default ComponentTokenPanel;
