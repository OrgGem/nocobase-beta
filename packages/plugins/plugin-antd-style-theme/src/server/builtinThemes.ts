/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ThemeItem } from '../types';

/** antd 默认主题 */
export const defaultTheme: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Default',
  },
  optional: true,
  isBuiltIn: true,
  uid: 'default',
  default: process.env.__E2E__ ? true : false,
};

export const dark: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Dark',
    // @ts-ignore
    algorithm: 'darkAlgorithm',
  },
  optional: true,
  isBuiltIn: true,
  uid: 'dark',
  default: false,
};

export const compact: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Compact',
    // @ts-ignore
    algorithm: 'compactAlgorithm',
    token: {
      fontSize: 16,
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'compact',
  default: process.env.__E2E__ ? false : true,
};

/** 同时包含 `紧凑` 和 `暗黑` 两种模式 */
export const compactDark: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Compact dark',
    // @ts-ignore
    algorithm: ['compactAlgorithm', 'darkAlgorithm'],
    token: {
      fontSize: 16,
      colorBgHeader: '#000000',
      colorPrimaryHeader: '#000000',
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'compact_dark',
  default: false,
};

/**
 * Business Pro — Clean, flat, professional light theme
 * Inspired by modern SaaS dashboards (Notion, Linear, Stripe)
 * Key: Refined blue-gray palette, generous spacing, minimal borders, soft shadows
 */
export const businessPro: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Business Pro',
    token: {
      // Brand — sophisticated blue with slight indigo undertone
      colorPrimary: '#4F46E5',
      colorSuccess: '#059669',
      colorWarning: '#D97706',
      colorError: '#DC2626',
      colorInfo: '#4F46E5',

      // Typography — clean and readable
      fontSize: 14,
      fontSizeHeading1: 30,
      fontSizeHeading2: 24,
      fontSizeHeading3: 20,
      fontSizeHeading4: 16,
      fontSizeHeading5: 14,

      // Spacing — generous breathing room
      sizeStep: 4,
      sizeUnit: 4,
      padding: 16,
      paddingLG: 24,
      margin: 16,
      marginLG: 24,

      // Style — flat with subtle radius
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,
      wireframe: false,

      // Neutral — warm gray tones
      colorBgBase: '#FAFAFA',
      colorTextBase: '#1E293B',

      // Shadows — soft and minimal
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.06), 0 1px 2px -1px rgba(0, 0, 0, 0.06)',
      boxShadowSecondary: '0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05)',

      // NocoBase custom — header & sider
      colorBgHeader: '#FFFFFF',
      colorTextHeaderMenu: '#475569',
      colorTextHeaderMenuHover: '#4F46E5',
      colorTextHeaderMenuActive: '#4F46E5',
      colorBgHeaderMenuHover: '#F1F5F9',
      colorBgHeaderMenuActive: '#EEF2FF',

      colorBgSider: '#F8FAFC',
      colorTextSiderMenu: '#475569',
      colorTextSiderMenuHover: '#4F46E5',
      colorTextSiderMenuActive: '#4F46E5',
      colorBgSiderMenuHover: '#F1F5F9',
      colorBgSiderMenuActive: '#EEF2FF',
    },
    components: {
      Button: {
        primaryShadow: '0 2px 4px -1px rgba(79, 70, 229, 0.3)',
        defaultBorderColor: '#E2E8F0',
        defaultBg: '#FFFFFF',
        borderRadius: 8,
      },
      Input: {
        activeBorderColor: '#4F46E5',
        hoverBorderColor: '#818CF8',
        addonBg: '#F8FAFC',
        activeShadow: '0 0 0 2px rgba(79, 70, 229, 0.08)',
      },
      Select: {
        optionSelectedBg: '#EEF2FF',
        optionActiveBg: '#F1F5F9',
        selectorBg: '#FFFFFF',
      },
      Table: {
        headerBg: '#F8FAFC',
        headerColor: '#475569',
        headerSortActiveBg: '#F1F5F9',
        rowHoverBg: '#F8FAFC',
        borderColor: '#F1F5F9',
      },
      Card: {
        headerBg: 'transparent',
      },
      Menu: {
        itemBg: 'transparent',
        itemHoverBg: '#F1F5F9',
        itemSelectedBg: '#EEF2FF',
        itemSelectedColor: '#4F46E5',
        itemColor: '#475569',
        subMenuItemBg: 'transparent',
        itemBorderRadius: 8,
      },
      Tabs: {
        inkBarColor: '#4F46E5',
        itemActiveColor: '#4F46E5',
        itemSelectedColor: '#4F46E5',
        itemHoverColor: '#818CF8',
      },
      Modal: {
        headerBg: '#FFFFFF',
        contentBg: '#FFFFFF',
        titleColor: '#1E293B',
      },
      Collapse: {
        headerBg: '#FAFAFA',
        contentBg: '#FFFFFF',
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'business_pro',
  default: false,
};

/**
 * Midnight Enterprise — Premium dark theme with deep navy accent
 * Inspired by Vercel Dashboard, GitHub Dark, Linear Dark
 * Key: Deep navy-black, purple-blue accent, glass-like cards, crisp typography
 */
export const midnightEnterprise: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Midnight Enterprise',
    // @ts-ignore
    algorithm: 'darkAlgorithm',
    token: {
      // Brand — vibrant violet-blue
      colorPrimary: '#7C3AED',
      colorSuccess: '#10B981',
      colorWarning: '#F59E0B',
      colorError: '#EF4444',
      colorInfo: '#7C3AED',

      // Typography
      fontSize: 14,

      // Spacing
      sizeStep: 4,
      sizeUnit: 4,

      // Style — modern rounded
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,
      wireframe: false,

      // Neutral — deep navy blacks
      colorBgBase: '#0A0A0F',
      colorTextBase: '#E2E8F0',

      // Shadows — subtle glow
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px -1px rgba(0, 0, 0, 0.3)',
      boxShadowSecondary: '0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3)',

      // NocoBase custom — header & sider
      colorBgHeader: '#0F0F18',
      colorTextHeaderMenu: '#94A3B8',
      colorTextHeaderMenuHover: '#C4B5FD',
      colorTextHeaderMenuActive: '#A78BFA',
      colorBgHeaderMenuHover: '#1E1E2E',
      colorBgHeaderMenuActive: '#1E1B3A',

      colorBgSider: '#0F0F18',
      colorTextSiderMenu: '#94A3B8',
      colorTextSiderMenuHover: '#C4B5FD',
      colorTextSiderMenuActive: '#A78BFA',
      colorBgSiderMenuHover: '#1E1E2E',
      colorBgSiderMenuActive: '#1E1B3A',
    },
    components: {
      Button: {
        primaryShadow: '0 2px 8px -2px rgba(124, 58, 237, 0.5)',
        defaultBorderColor: '#2D2D3F',
        defaultBg: '#16161F',
        defaultColor: '#C4B5FD',
        borderRadius: 8,
      },
      Input: {
        activeBorderColor: '#7C3AED',
        hoverBorderColor: '#6D28D9',
        addonBg: '#16161F',
        activeShadow: '0 0 0 2px rgba(124, 58, 237, 0.15)',
        colorBgContainer: '#111118',
      },
      Select: {
        optionSelectedBg: '#1E1B3A',
        optionActiveBg: '#1E1E2E',
        selectorBg: '#111118',
      },
      Table: {
        headerBg: '#111118',
        headerColor: '#94A3B8',
        headerSortActiveBg: '#16161F',
        rowHoverBg: '#16161F',
        borderColor: '#1E1E2E',
      },
      Card: {
        colorBgContainer: '#111118',
        headerBg: 'transparent',
      },
      Menu: {
        itemBg: 'transparent',
        itemHoverBg: '#1E1E2E',
        itemSelectedBg: '#1E1B3A',
        itemSelectedColor: '#A78BFA',
        itemColor: '#94A3B8',
        subMenuItemBg: 'transparent',
        darkItemBg: '#0F0F18',
        darkItemSelectedBg: '#1E1B3A',
        darkSubMenuItemBg: '#0A0A0F',
        itemBorderRadius: 8,
      },
      Tabs: {
        inkBarColor: '#7C3AED',
        itemActiveColor: '#A78BFA',
        itemSelectedColor: '#A78BFA',
        itemHoverColor: '#C4B5FD',
      },
      Modal: {
        headerBg: '#111118',
        contentBg: '#111118',
        titleColor: '#E2E8F0',
      },
      Collapse: {
        headerBg: '#111118',
        contentBg: '#0F0F18',
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'midnight_enterprise',
  default: false,
};

/**
 * VPBank — Banking-style theme inspired by VPBank (vpbank.com.vn)
 * Primary Green: #00B74F (logo green), Navy: #2E3A5B (headings),
 * Red accent: #EE1C25 (logo flower), Clean white backgrounds
 * Style: Flat, high border-radius, modern sans-serif, light shadows
 */
export const vpbank: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'VPBank',
    // @ts-ignore
    algorithm: 'compactAlgorithm',
    token: {
      // Brand — VPBank signature green
      colorPrimary: '#00B74F',
      colorSuccess: '#00B74F',
      colorWarning: '#F5A623',
      colorError: '#EE1C25',
      colorInfo: '#00B74F',

      // Typography — compact and professional
      fontSize: 13,
      fontSizeHeading1: 22,
      fontSizeHeading2: 18,
      fontSizeHeading3: 15,
      fontSizeHeading4: 14,
      fontSizeHeading5: 13,
      colorTextBase: '#2E3A5B',

      // Neutral — clean white
      colorBgBase: '#FFFFFF',

      // Spacing — tighter for data-dense screens
      sizeStep: 4,
      sizeUnit: 4,
      padding: 12,
      paddingLG: 16,
      paddingSM: 8,
      paddingXS: 4,
      margin: 12,
      marginLG: 16,
      marginSM: 8,
      marginXS: 4,

      // Style — moderate rounded
      borderRadius: 6,
      borderRadiusLG: 8,
      borderRadiusSM: 4,
      wireframe: false,

      // Shadows — very soft and subtle
      boxShadow: '0 1px 3px 0 rgba(46, 58, 91, 0.06), 0 1px 2px -1px rgba(46, 58, 91, 0.04)',
      boxShadowSecondary: '0 3px 8px -2px rgba(46, 58, 91, 0.08), 0 2px 4px -2px rgba(46, 58, 91, 0.04)',

      // NocoBase custom — header (white/clean like VPBank nav)
      colorBgHeader: '#FFFFFF',
      colorTextHeaderMenu: '#2E3A5B',
      colorTextHeaderMenuHover: '#00B74F',
      colorTextHeaderMenuActive: '#009A44',
      colorBgHeaderMenuHover: '#F0FFF4',
      colorBgHeaderMenuActive: '#E6FFED',

      // NocoBase custom — sider (light green-tinted)
      colorBgSider: '#F8FFF9',
      colorTextSiderMenu: '#2E3A5B',
      colorTextSiderMenuHover: '#00B74F',
      colorTextSiderMenuActive: '#009A44',
      colorBgSiderMenuHover: '#F0FFF4',
      colorBgSiderMenuActive: '#E6FFED',
    },
    components: {
      Button: {
        primaryShadow: '0 1px 4px -1px rgba(0, 183, 79, 0.3)',
        defaultBorderColor: '#D4E5D9',
        defaultBg: '#FFFFFF',
        borderRadius: 6,
        controlHeight: 32,
        controlHeightLG: 36,
        controlHeightSM: 24,
        paddingContentHorizontal: 12,
      },
      Input: {
        activeBorderColor: '#00B74F',
        hoverBorderColor: '#34D399',
        addonBg: '#F8FFF9',
        activeShadow: '0 0 0 2px rgba(0, 183, 79, 0.1)',
        borderRadius: 6,
        controlHeight: 32,
        paddingSM: 8,
      },
      Select: {
        optionSelectedBg: '#E6FFED',
        optionActiveBg: '#F0FFF4',
        selectorBg: '#FFFFFF',
        borderRadius: 6,
        controlHeight: 32,
      },
      Table: {
        headerBg: '#F8FFF9',
        headerColor: '#2E3A5B',
        headerSortActiveBg: '#F0FFF4',
        rowHoverBg: '#FAFFFE',
        borderColor: '#E6EDEA',
        cellPaddingBlock: 8,
        cellPaddingInline: 8,
        cellPaddingBlockSM: 4,
        cellPaddingInlineSM: 4,
      },
      Card: {
        headerBg: 'transparent',
        borderRadiusLG: 8,
        paddingLG: 16,
      },
      Menu: {
        itemBg: 'transparent',
        itemHoverBg: '#F0FFF4',
        itemSelectedBg: '#E6FFED',
        itemSelectedColor: '#009A44',
        itemColor: '#2E3A5B',
        subMenuItemBg: 'transparent',
        itemBorderRadius: 6,
        itemHeight: 36,
        itemMarginBlock: 2,
        itemMarginInline: 4,
      },
      Tabs: {
        inkBarColor: '#00B74F',
        itemActiveColor: '#009A44',
        itemSelectedColor: '#009A44',
        itemHoverColor: '#34D399',
      },
      Modal: {
        headerBg: '#FFFFFF',
        contentBg: '#FFFFFF',
        titleColor: '#2E3A5B',
        borderRadiusLG: 8,
      },
      Collapse: {
        headerBg: '#F8FFF9',
        contentBg: '#FFFFFF',
        headerPadding: '8px 12px',
        contentPadding: '8px 12px',
      },
      Form: {
        itemMarginBottom: 16,
      },
      Descriptions: {
        padding: 8,
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'vpbank',
  default: false,
};

/**
 * Tween One — Theme inspired by https://tween-one.vercel.app/ (Dumi/Ant Motion style)
 * Style: Clean white backgrounds, distinct gray-blue text (#454d64), classic Ant Design blue primary
 */
export const tweenOne: Omit<ThemeItem, 'id'> = {
  config: {
    name: 'Tween One',
    token: {
      colorPrimary: '#1890ff',
      colorInfo: '#1890ff',
      colorSuccess: '#52c41a',
      colorWarning: '#faad14',
      colorError: '#ff4d4f',

      colorTextBase: '#454d64',
      fontSize: 14,
      fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'`,

      // Spacing and sizing - tailored for a clean, documentation-like layout
      sizeStep: 4,
      sizeUnit: 4,
      padding: 16,
      paddingSM: 12,
      paddingXS: 8,
      margin: 16,
      marginSM: 12,
      marginXS: 8,
      
      colorBgBase: '#ffffff',
      borderRadius: 4,

      colorBgHeader: '#ffffff',
      colorTextHeaderMenu: '#454d64',
      colorTextHeaderMenuHover: '#1890ff',
      colorTextHeaderMenuActive: '#1890ff',
      colorBgHeaderMenuHover: '#f5f5f5',
      colorBgHeaderMenuActive: '#e6f7ff',

      colorBgSider: '#fafafa',
      colorTextSiderMenu: '#454d64',
      colorTextSiderMenuHover: '#1890ff',
      colorTextSiderMenuActive: '#1890ff',
      colorBgSiderMenuHover: '#e6f7ff',
      colorBgSiderMenuActive: '#e6f7ff',
    },
    components: {
      Button: {
        borderRadius: 4,
        defaultBg: '#ffffff',
      },
      Menu: {
        itemBg: 'transparent',
        itemHoverBg: '#f5f5f5',
        itemSelectedBg: '#e6f7ff',
        itemSelectedColor: '#1890ff',
        itemColor: '#454d64',
        subMenuItemBg: 'transparent',
        itemBorderRadius: 4,
      },
      Table: {
        headerBg: '#fafafa',
        headerColor: '#454d64',
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'tween_one',
  default: false,
};
