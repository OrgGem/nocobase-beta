/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { BuiltinThemeSeed } from '../types';

/** antd 默认主题 */
export const defaultTheme: BuiltinThemeSeed = {
  config: {
    name: 'Default',
  },
  optional: true,
  isBuiltIn: true,
  uid: 'default',
  default: process.env.__E2E__ ? true : false,
};

export const dark: BuiltinThemeSeed = {
  config: {
    name: 'Dark',
    algorithm: 'darkAlgorithm',
  },
  optional: true,
  isBuiltIn: true,
  uid: 'dark',
  default: false,
};

export const compact: BuiltinThemeSeed = {
  config: {
    name: 'Compact',
    algorithm: 'compactAlgorithm',
    token: {
      fontSize: 16,
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'compact',
  default: false,
};

/** 同时包含 `紧凑` 和 `暗黑` 两种模式 */
export const compactDark: BuiltinThemeSeed = {
  config: {
    name: 'Compact dark',
    algorithm: ['compactAlgorithm', 'darkAlgorithm'],
    token: {
      fontSize: 16,
      colorBgHeader: '#000000',
      colorPrimaryHeader: '#000000',
      colorSettings: '#F18B62',
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
export const businessPro: BuiltinThemeSeed = {
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

      colorSettings: '#F18B62',
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
export const midnightEnterprise: BuiltinThemeSeed = {
  config: {
    name: 'Midnight Enterprise',
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

      colorSettings: '#F18B62',
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
export const vpbank: BuiltinThemeSeed = {
  config: {
    name: 'VPBank',
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

      colorSettings: '#F18B62',
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
export const tweenOne: BuiltinThemeSeed = {
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

      colorSettings: '#F18B62',
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

/**
 * Muse Dashboard — Theme inspired by Creative Tim's Muse Ant Design Dashboard
 * Style: Clean white cards with generous border-radius, soft shadows, light gray-blue layout background.
 */
export const museDashboard: BuiltinThemeSeed = {
  config: {
    name: 'Muse Dashboard',
    token: {
      colorPrimary: '#1890ff',
      colorSuccess: '#52c41a',
      colorWarning: '#faad14',
      colorError: '#ff4d4f',
      colorInfo: '#1890ff',

      colorTextBase: 'rgba(0, 0, 0, 0.85)',
      fontSize: 14,
      fontFamily: `'Helvetica Neue', Arial, sans-serif`,

      sizeStep: 4,
      sizeUnit: 4,

      colorBgBase: '#ffffff',
      colorBgLayout: '#f0f2f5',
      borderRadius: 6,
      borderRadiusLG: 12,
      borderRadiusSM: 4,

      boxShadow: '0 20px 27px 0 rgba(0, 0, 0, 0.05)',

      // NocoBase custom — header
      colorBgHeader: '#ffffff',
      colorTextHeaderMenu: 'rgba(0, 0, 0, 0.85)',
      colorTextHeaderMenuHover: '#1890ff',
      colorTextHeaderMenuActive: '#1890ff',
      colorBgHeaderMenuHover: '#f0f2f5',
      colorBgHeaderMenuActive: '#e6f7ff',

      // NocoBase custom — sider
      colorBgSider: '#ffffff',
      colorTextSiderMenu: 'rgba(0, 0, 0, 0.85)',
      colorTextSiderMenuHover: '#1890ff',
      colorTextSiderMenuActive: '#1890ff',
      colorBgSiderMenuHover: '#f0f2f5',
      colorBgSiderMenuActive: '#e6f7ff',

      colorSettings: '#F18B62',
    },
    components: {
      Button: {
        borderRadius: 6,
        controlHeight: 40,
      },
      Card: {
        headerBg: 'transparent',
        borderRadiusLG: 12,
      },
      Menu: {
        itemBg: 'transparent',
        itemHoverBg: '#f0f2f5',
        itemSelectedBg: '#ffffff',
        itemSelectedColor: '#1890ff',
        itemColor: 'rgba(0, 0, 0, 0.85)',
        subMenuItemBg: 'transparent',
        itemBorderRadius: 12,
      },
      Table: {
        headerBg: 'transparent',
        headerColor: 'rgba(0, 0, 0, 0.45)',
        rowHoverBg: '#fafafa',
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'muse_dashboard',
  default: false,
};

const STUDIO_FONT_SANS =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const STUDIO_FONT_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

function buildStudioGlobalStyle(mode: 'light' | 'dark'): string {
  const isDark = mode === 'dark';
  const headerBg = isDark ? 'rgba(7, 7, 7, 0.85)' : 'rgba(250, 250, 250, 0.85)';
  const headerText = isDark ? '#f2f2f2' : '#0d0d0d';
  const siderBg = isDark ? '#121212' : '#ffffff';
  const canvasBg = isDark ? '#070707' : '#fafafa';
  const border = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(222, 222, 222, 0.6)';
  const cardHoverBorder = isDark ? 'rgba(0, 209, 91, 0.35)' : 'rgba(0, 183, 79, 0.35)';
  const cardHoverShadow = isDark ? '0 2px 10px rgba(0, 0, 0, 0.35)' : '0 2px 8px rgba(0, 183, 79, 0.08)';
  const glowColor = isDark ? 'rgba(0, 209, 91, 0.09)' : 'rgba(0, 183, 79, 0.08)';
  const selectionBg = isDark ? 'rgba(0, 209, 91, 0.28)' : 'rgba(0, 183, 79, 0.18)';
  const selectionColor = isDark ? '#fafafa' : '#0d0d0d';
  const thumbBg = isDark ? 'rgba(158, 158, 158, 0.22)' : 'rgba(105, 105, 105, 0.2)';
  const thumbHoverBg = isDark ? 'rgba(158, 158, 158, 0.38)' : 'rgba(105, 105, 105, 0.35)';

  return `
body {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
::selection {
  background: ${selectionBg};
  color: ${selectionColor};
}
.ant-layout-header.ant-pro-layout-header {
  background-color: ${headerBg} !important;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-block-end: 1px solid ${border} !important;
  box-shadow: none !important;
}
.ant-layout-header.ant-pro-layout-header .ant-pro-global-header-logo,
.ant-layout-header.ant-pro-layout-header .ant-pro-global-header-logo > div,
.ant-layout-header.ant-pro-layout-header .ant-pro-global-header-logo span,
.ant-layout-header.ant-pro-layout-header .ant-pro-top-nav-header-logo,
.ant-layout-header.ant-pro-layout-header .ant-pro-top-nav-header-logo > div,
.ant-layout-header.ant-pro-layout-header .ant-pro-top-nav-header-logo span {
  color: ${headerText} !important;
}
.ant-pro-sider.ant-layout-sider,
.ant-layout-sider {
  background-color: ${siderBg} !important;
  border-inline-end: 1px solid ${border} !important;
  box-shadow: none !important;
}
.ant-layout-sider .ant-menu-item-selected {
  font-weight: 500;
}
.ant-tabs .ant-tabs-tab.ant-tabs-tab-active .ant-tabs-tab-btn {
  font-weight: 600;
}
.ant-pro-layout .ant-pro-layout-content,
.ant-layout-content {
  background-color: ${canvasBg};
  background-image: radial-gradient(ellipse at 100% 0%, ${glowColor}, transparent 70%);
  background-size: 100% 18rem;
  background-repeat: no-repeat;
}
.ant-card {
  border: 1px solid ${border};
  box-shadow: none;
}
.ant-card.ant-card-hoverable:hover {
  border-color: ${cardHoverBorder};
  box-shadow: ${cardHoverShadow};
}
.ant-table-wrapper .ant-table-container {
  border: 1px solid ${border};
  border-radius: 11px;
  overflow: hidden;
}
.ant-table-wrapper .ant-table-thead > tr > th {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.ant-table-wrapper .ant-table-thead > tr > th::before {
  display: none !important;
}
.ant-page-header-heading-title,
h1.ant-typography,
h2.ant-typography {
  letter-spacing: -0.025em;
  font-weight: 600;
}
.ant-popover .ant-popover-inner,
.ant-dropdown .ant-dropdown-menu {
  border: 1px solid ${border};
}
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: ${thumbBg};
  border-radius: 9999px;
}
::-webkit-scrollbar-thumb:hover {
  background: ${thumbHoverBg};
}
`.trim();
}

/**
 * VPBank Light — Studio-inspired compact workspace styled with VPBank signature emerald green (#00B74F)
 * Key: #fafafa canvas with subtle top-right emerald radial glow, pure white sidebar/cards with 1px hairline borders,
 * frosted translucent top header, VPBank green primary/buttons/tabs/selection (#00B74F / #009A44 / #E6FFED).
 */
export const vpbankLight: BuiltinThemeSeed = {
  config: {
    name: 'VPBank Light',
    algorithm: 'compactAlgorithm',
    token: {
      // Brand & semantic status (VPBank signature palette)
      colorPrimary: '#00B74F',
      colorPrimaryHover: '#00A346',
      colorPrimaryActive: '#008F3D',
      colorInfo: '#00B74F',
      colorLink: '#009A44',
      colorLinkHover: '#00B74F',
      colorLinkActive: '#007D37',
      colorSuccess: '#00B74F',
      colorSuccessBg: '#ECFDF3',
      colorWarning: '#D97706',
      colorWarningBg: '#FFF6E5',
      colorError: '#EE1C25',
      colorErrorBg: '#FEF2F2',

      // Neutrals & surfaces (Studio OKLCH grayscale converted to sRGB)
      colorBgBase: '#ffffff',
      colorBgLayout: '#fafafa',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorTextBase: '#0d0d0d',
      colorText: '#0d0d0d',
      colorTextSecondary: '#696969',
      colorTextTertiary: '#8c8c8c',
      colorBorder: '#dedede',
      colorBorderSecondary: 'rgba(222, 222, 222, 0.6)',
      colorSplit: 'rgba(222, 222, 222, 0.6)',
      colorFillTertiary: '#f6f6f6',
      colorFillSecondary: '#f2f2f2',
      colorPrimaryBg: '#E6FFED',
      colorPrimaryBgHover: '#D3F9DF',
      colorPrimaryBorder: 'rgba(0, 183, 79, 0.3)',

      // Typography
      fontFamily: STUDIO_FONT_SANS,
      fontFamilyCode: STUDIO_FONT_MONO,
      fontSize: 14,
      fontSizeSM: 12,
      fontSizeLG: 16,
      fontSizeHeading1: 24,
      fontSizeHeading2: 20,
      fontSizeHeading3: 16,
      fontSizeHeading4: 14,
      fontSizeHeading5: 13,
      lineHeight: 1.371,

      // Radii & compact spacing
      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusXS: 4,
      borderRadiusLG: 11,
      borderRadiusBlock: 11,
      controlHeight: 30,
      controlHeightSM: 26,
      controlHeightLG: 36,
      sizeStep: 4,
      sizeUnit: 4,
      padding: 14,
      paddingLG: 20,
      paddingSM: 10,
      paddingXS: 6,
      margin: 14,
      marginLG: 20,
      marginSM: 10,
      marginXS: 6,
      paddingPageHorizontal: 22,
      paddingPageVertical: 20,
      marginBlock: 16,
      siderWidth: 230,
      wireframe: false,

      // Shadows (reserved for floating overlays; cards remain flat via hairline borders)
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.06)',
      boxShadowSecondary: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.06)',

      // NocoBase layout — frosted light header & crisp white sidebar with VPBank green selection
      colorPrimaryHeader: '#00B74F',
      colorBgHeader: '#fafafa',
      colorTextHeaderMenu: '#0d0d0d',
      colorTextHeaderMenuHover: '#009A44',
      colorTextHeaderMenuActive: '#009A44',
      colorBgHeaderMenuHover: '#F0FFF4',
      colorBgHeaderMenuActive: '#E6FFED',

      colorBgSider: '#ffffff',
      colorTextSiderMenu: '#0d0d0d',
      colorTextSiderMenuHover: '#009A44',
      colorTextSiderMenuActive: '#009A44',
      colorBgSiderMenuHover: '#F0FFF4',
      colorBgSiderMenuActive: '#E6FFED',

      colorSettings: '#F18B62',

      // Login page VPBank Light branding
      loginBgColor: '#fafafa',
      loginBgGradient: 'radial-gradient(ellipse at 100% 0%, rgba(0, 183, 79, 0.1), transparent 65%), #fafafa',
      loginCardBg: '#ffffff',
      loginCardBorderRadius: 12,
      loginCardShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.04), 0 0 0 1px rgba(222, 222, 222, 0.6)',
      loginBtnBg: '#00B74F',
      loginBtnBorderRadius: 8,

      globalStyle: buildStudioGlobalStyle('light'),
    },
    components: {
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        defaultBg: '#ffffff',
        defaultBorderColor: '#dedede',
        defaultColor: '#0d0d0d',
        defaultHoverBg: '#F0FFF4',
        defaultHoverBorderColor: '#00B74F',
        defaultHoverColor: '#009A44',
        defaultActiveBorderColor: '#009A44',
        defaultActiveColor: '#009A44',
        borderRadius: 8,
        borderRadiusSM: 6,
        controlHeight: 30,
        controlHeightSM: 26,
        fontWeight: 500,
        paddingInline: 12,
      },
      Input: {
        activeBorderColor: '#00B74F',
        hoverBorderColor: '#34D399',
        addonBg: '#f6f6f6',
        activeShadow: '0 0 0 2px rgba(0, 183, 79, 0.16)',
        borderRadius: 8,
        controlHeight: 30,
      },
      Select: {
        optionSelectedBg: '#E6FFED',
        optionSelectedColor: '#009A44',
        optionSelectedFontWeight: 500,
        optionActiveBg: '#F0FFF4',
        selectorBg: '#ffffff',
        borderRadius: 8,
        controlHeight: 30,
      },
      Table: {
        headerBg: '#f6f6f6',
        headerColor: 'rgba(13, 13, 13, 0.72)',
        headerSortActiveBg: '#efefef',
        headerSortHoverBg: '#efefef',
        headerSplitColor: 'transparent',
        rowHoverBg: '#F7FFFA',
        rowSelectedBg: '#E6FFED',
        rowSelectedHoverBg: '#D8FBE3',
        borderColor: 'rgba(222, 222, 222, 0.6)',
        cellPaddingBlock: 8,
        cellPaddingInline: 12,
        cellPaddingBlockSM: 6,
        cellPaddingInlineSM: 8,
        headerBorderRadius: 10,
      },
      Card: {
        colorBgContainer: '#ffffff',
        headerBg: 'transparent',
        borderRadiusLG: 11,
        paddingLG: 16,
        headerFontSize: 14,
        headerHeight: 44,
        boxShadowTertiary: 'none',
      },
      Menu: {
        itemBg: 'transparent',
        itemColor: '#0d0d0d',
        itemHoverBg: '#F0FFF4',
        itemHoverColor: '#009A44',
        itemSelectedBg: '#E6FFED',
        itemSelectedColor: '#009A44',
        subMenuItemBg: 'transparent',
        groupTitleColor: 'rgba(13, 13, 13, 0.5)',
        groupTitleFontSize: 12,
        itemBorderRadius: 6,
        itemHeight: 36,
        itemMarginBlock: 2,
        itemMarginInline: 8,
        iconSize: 15,
      },
      Tabs: {
        inkBarColor: '#00B74F',
        itemColor: '#696969',
        itemActiveColor: '#009A44',
        itemSelectedColor: '#009A44',
        itemHoverColor: '#00B74F',
        titleFontSize: 14,
        horizontalItemPadding: '10px 0',
        horizontalItemGutter: 20,
      },
      Tag: {
        borderRadiusSM: 6,
        defaultBg: '#f2f2f2',
        defaultColor: '#696969',
      },
      Modal: {
        headerBg: '#ffffff',
        contentBg: '#ffffff',
        footerBg: '#ffffff',
        titleColor: '#0d0d0d',
        titleFontSize: 16,
        borderRadiusLG: 11,
      },
      Drawer: {
        colorBgElevated: '#ffffff',
      },
      Segmented: {
        trackBg: '#f2f2f2',
        itemSelectedBg: '#ffffff',
        itemSelectedColor: '#009A44',
        itemColor: '#696969',
        borderRadius: 8,
        borderRadiusSM: 6,
      },
      Breadcrumb: {
        itemColor: '#696969',
        lastItemColor: '#0d0d0d',
        linkColor: '#696969',
        linkHoverColor: '#009A44',
        separatorColor: '#bdbdbd',
      },
      Collapse: {
        headerBg: '#fafafa',
        contentBg: '#ffffff',
        borderRadiusLG: 10,
      },
      Dropdown: {
        borderRadiusLG: 8,
        paddingBlock: 6,
      },
      Popover: {
        borderRadiusLG: 10,
      },
      Form: {
        itemMarginBottom: 14,
        labelColor: '#0d0d0d',
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'vpbank_light',
  default: process.env.__E2E__ ? false : true,
};

/**
 * VPBank Dark — Dark mode Studio-inspired workspace styled with luminous VPBank emerald (#00D15B)
 * Key: Deep neutral #070707 canvas, #121212 sidebar/cards with 10% white hairline borders,
 * luminous VPBank green primary/buttons/tabs/selection (#00D15B / #34D399 / #0F2E1E) with crisp dark button foreground (#042312).
 */
export const vpbankDark: BuiltinThemeSeed = {
  config: {
    name: 'VPBank Dark',
    algorithm: ['compactAlgorithm', 'darkAlgorithm'],
    token: {
      // Brand & semantic status (VPBank dark palette)
      colorPrimary: '#00D15B',
      colorPrimaryHover: '#2CE378',
      colorPrimaryActive: '#00B74F',
      colorInfo: '#00D15B',
      colorLink: '#34D399',
      colorLinkHover: '#6EE7B7',
      colorLinkActive: '#00B74F',
      colorSuccess: '#34D399',
      colorSuccessBg: '#0E2B1C',
      colorWarning: '#F5B942',
      colorWarningBg: '#392B18',
      colorError: '#FF5C63',
      colorErrorBg: '#3B181A',

      // Neutrals & surfaces (Studio Dark OKLCH grayscale converted to sRGB)
      colorBgBase: '#121212',
      colorBgLayout: '#070707',
      colorBgContainer: '#121212',
      colorBgElevated: '#181818',
      colorTextBase: '#f2f2f2',
      colorText: '#f2f2f2',
      colorTextSecondary: '#9e9e9e',
      colorTextTertiary: '#737373',
      colorBorder: 'rgba(255, 255, 255, 0.15)',
      colorBorderSecondary: 'rgba(255, 255, 255, 0.1)',
      colorSplit: 'rgba(255, 255, 255, 0.1)',
      colorFillTertiary: '#1a1a1a',
      colorFillSecondary: '#1f1f1f',
      colorPrimaryBg: '#0F2E1E',
      colorPrimaryBgHover: '#153D28',
      colorPrimaryBorder: 'rgba(0, 209, 91, 0.35)',

      // Typography
      fontFamily: STUDIO_FONT_SANS,
      fontFamilyCode: STUDIO_FONT_MONO,
      fontSize: 14,
      fontSizeSM: 12,
      fontSizeLG: 16,
      fontSizeHeading1: 24,
      fontSizeHeading2: 20,
      fontSizeHeading3: 16,
      fontSizeHeading4: 14,
      fontSizeHeading5: 13,
      lineHeight: 1.371,

      // Radii & compact spacing
      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusXS: 4,
      borderRadiusLG: 11,
      borderRadiusBlock: 11,
      controlHeight: 30,
      controlHeightSM: 26,
      controlHeightLG: 36,
      sizeStep: 4,
      sizeUnit: 4,
      padding: 14,
      paddingLG: 20,
      paddingSM: 10,
      paddingXS: 6,
      margin: 14,
      marginLG: 20,
      marginSM: 10,
      marginXS: 6,
      paddingPageHorizontal: 22,
      paddingPageVertical: 20,
      marginBlock: 16,
      siderWidth: 230,
      wireframe: false,

      // Shadows
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.45), 0 2px 4px -2px rgba(0, 0, 0, 0.35)',
      boxShadowSecondary: '0 6px 12px -2px rgba(0, 0, 0, 0.5), 0 2px 6px -2px rgba(0, 0, 0, 0.4)',

      // NocoBase layout — frosted dark header & charcoal sidebar with VPBank emerald selection
      colorPrimaryHeader: '#00D15B',
      colorBgHeader: '#0d0d0d',
      colorTextHeaderMenu: '#f2f2f2',
      colorTextHeaderMenuHover: '#34D399',
      colorTextHeaderMenuActive: '#34D399',
      colorBgHeaderMenuHover: '#16261D',
      colorBgHeaderMenuActive: '#0F2E1E',

      colorBgSider: '#121212',
      colorTextSiderMenu: '#f2f2f2',
      colorTextSiderMenuHover: '#34D399',
      colorTextSiderMenuActive: '#34D399',
      colorBgSiderMenuHover: '#16261D',
      colorBgSiderMenuActive: '#0F2E1E',

      colorSettings: '#F18B62',

      // Login page VPBank Dark branding
      loginBgColor: '#070707',
      loginBgGradient: 'radial-gradient(ellipse at 100% 0%, rgba(0, 209, 91, 0.12), transparent 65%), #070707',
      loginCardBg: '#121212',
      loginCardBorderRadius: 12,
      loginCardShadow: '0 4px 16px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.1)',
      loginBtnBg: '#00D15B',
      loginBtnBorderRadius: 8,

      globalStyle: buildStudioGlobalStyle('dark'),
    },
    components: {
      Button: {
        primaryColor: '#042312',
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        defaultBg: '#121212',
        defaultBorderColor: 'rgba(255, 255, 255, 0.15)',
        defaultColor: '#f2f2f2',
        defaultHoverBg: '#16261D',
        defaultHoverBorderColor: 'rgba(0, 209, 91, 0.45)',
        defaultHoverColor: '#34D399',
        defaultActiveBorderColor: '#00D15B',
        defaultActiveColor: '#34D399',
        borderRadius: 8,
        borderRadiusSM: 6,
        controlHeight: 30,
        controlHeightSM: 26,
        fontWeight: 500,
        paddingInline: 12,
      },
      Input: {
        activeBorderColor: '#00D15B',
        hoverBorderColor: 'rgba(0, 209, 91, 0.45)',
        addonBg: '#1a1a1a',
        colorBgContainer: '#121212',
        activeShadow: '0 0 0 2px rgba(0, 209, 91, 0.22)',
        borderRadius: 8,
        controlHeight: 30,
      },
      Select: {
        optionSelectedBg: '#0F2E1E',
        optionSelectedColor: '#34D399',
        optionSelectedFontWeight: 500,
        optionActiveBg: '#16261D',
        selectorBg: '#121212',
        borderRadius: 8,
        controlHeight: 30,
      },
      Table: {
        headerBg: '#1a1a1a',
        headerColor: 'rgba(242, 242, 242, 0.78)',
        headerSortActiveBg: '#222222',
        headerSortHoverBg: '#222222',
        headerSplitColor: 'transparent',
        rowHoverBg: '#141f19',
        rowSelectedBg: '#0F2E1E',
        rowSelectedHoverBg: '#153A26',
        borderColor: 'rgba(255, 255, 255, 0.1)',
        cellPaddingBlock: 8,
        cellPaddingInline: 12,
        cellPaddingBlockSM: 6,
        cellPaddingInlineSM: 8,
        headerBorderRadius: 10,
      },
      Card: {
        colorBgContainer: '#121212',
        headerBg: 'transparent',
        borderRadiusLG: 11,
        paddingLG: 16,
        headerFontSize: 14,
        headerHeight: 44,
        boxShadowTertiary: 'none',
      },
      Menu: {
        itemBg: 'transparent',
        itemColor: '#f2f2f2',
        itemHoverBg: '#16261D',
        itemHoverColor: '#34D399',
        itemSelectedBg: '#0F2E1E',
        itemSelectedColor: '#34D399',
        subMenuItemBg: 'transparent',
        darkItemBg: '#121212',
        darkItemSelectedBg: '#0F2E1E',
        darkSubMenuItemBg: '#0d0d0d',
        groupTitleColor: 'rgba(242, 242, 242, 0.5)',
        groupTitleFontSize: 12,
        itemBorderRadius: 6,
        itemHeight: 36,
        itemMarginBlock: 2,
        itemMarginInline: 8,
        iconSize: 15,
      },
      Tabs: {
        inkBarColor: '#00D15B',
        itemColor: '#9e9e9e',
        itemActiveColor: '#34D399',
        itemSelectedColor: '#34D399',
        itemHoverColor: '#6EE7B7',
        titleFontSize: 14,
        horizontalItemPadding: '10px 0',
        horizontalItemGutter: 20,
      },
      Tag: {
        borderRadiusSM: 6,
        defaultBg: '#1f1f1f',
        defaultColor: '#9e9e9e',
      },
      Modal: {
        headerBg: '#121212',
        contentBg: '#121212',
        footerBg: '#121212',
        titleColor: '#fafafa',
        titleFontSize: 16,
        borderRadiusLG: 11,
      },
      Drawer: {
        colorBgElevated: '#121212',
      },
      Segmented: {
        trackBg: '#1d1d1d',
        itemSelectedBg: '#0F2E1E',
        itemSelectedColor: '#34D399',
        itemColor: '#9e9e9e',
        borderRadius: 8,
        borderRadiusSM: 6,
      },
      Breadcrumb: {
        itemColor: '#9e9e9e',
        lastItemColor: '#f2f2f2',
        linkColor: '#9e9e9e',
        linkHoverColor: '#34D399',
        separatorColor: '#525252',
      },
      Collapse: {
        headerBg: '#181818',
        contentBg: '#121212',
        borderRadiusLG: 10,
      },
      Dropdown: {
        borderRadiusLG: 8,
        paddingBlock: 6,
      },
      Popover: {
        borderRadiusLG: 10,
      },
      Form: {
        itemMarginBottom: 14,
        labelColor: '#f2f2f2',
      },
    },
  },
  optional: true,
  isBuiltIn: true,
  uid: 'vpbank_dark',
  default: false,
};

export const ALL_BUILTIN_THEMES: BuiltinThemeSeed[] = [
  defaultTheme,
  dark,
  compact,
  compactDark,
  businessPro,
  midnightEnterprise,
  vpbank,
  tweenOne,
  museDashboard,
  vpbankLight,
  vpbankDark,
];
