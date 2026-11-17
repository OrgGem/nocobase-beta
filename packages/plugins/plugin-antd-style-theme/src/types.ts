/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { ThemeConfig as Config } from '@nocobase/client-v2';
import type { ReactElement } from 'react';

export type ThemeConfig = Config;
export type ThemeId = number | string;
export type StoredAlgorithm = 'defaultAlgorithm' | 'darkAlgorithm' | 'compactAlgorithm';

export interface LoginThemeTokens {
  appFavicon?: string;
  appTitle?: string;
  loginBgColor?: string;
  loginBgImage?: string;
  loginBgGradient?: string;
  loginLogoUrl?: string;
  loginLogoHeight?: number;
  loginCardBg?: string;
  loginCardBorderRadius?: number;
  loginCardShadow?: string;
  loginCardWidth?: number;
  loginBtnBg?: string;
  loginBtnBorderRadius?: number;
}

export type StoredThemeConfig = Omit<ThemeConfig, 'algorithm' | 'token'> & {
  algorithm?: ThemeConfig['algorithm'] | StoredAlgorithm | StoredAlgorithm[];
  token?: ThemeConfig['token'] & LoginThemeTokens;
};

export interface ThemeItem {
  id: ThemeId;
  /** 主题配置内容，一个 JSON 字符串 */
  config: ThemeConfig | null;
  /** 主题是否可选 */
  optional: boolean;
  isBuiltIn?: boolean;
  uid?: string;
  default?: boolean; // 当前系统默认主题
}

export interface StoredThemeItem extends Omit<ThemeItem, 'config'> {
  config: StoredThemeConfig | null;
}

export interface BuiltinThemeSeed extends Omit<StoredThemeItem, 'id'> {
  isBuiltIn: boolean;
  uid: string;
}

export type Theme = {
  name: string;
  key: string;
  config: ThemeConfig;
};

export type AliasToken = Exclude<ThemeConfig['token'], undefined>;
export type TokenValue = string | number | string[] | number[] | boolean;
export type TokenName = keyof AliasToken;

export interface ComponentDemo {
  tokens?: TokenName[];
  demo: ReactElement;
  key: string;
}

export interface MutableTheme extends Theme {
  onThemeChange?: (newTheme: ThemeConfig, path: string[]) => void;
  onReset?: (path: string[]) => void;
  onAbort?: (path: string[]) => void;
  getCanReset?: (path: string[]) => boolean;
}

export type PreviewerProps = {
  onSave?: (themeConfig: ThemeConfig) => void;
  showTheme?: boolean;
  theme?: Theme;
  onThemeChange?: (config: ThemeConfig) => void;
};

export type SelectedToken = {
  seed?: string[];
  map?: string[];
  alias?: string[];
};
