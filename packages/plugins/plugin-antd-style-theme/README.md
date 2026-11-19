# plugin-antd-style-theme

## Overview
Advanced Ant Design v5 component-level style theme editor for NocoBase (supporting both v1 and v2 client runtimes). Customize global design tokens, per-component tokens (Menu, Table, Button, Input, Select, and more), Header/Sider layout tokens, and `/signin` page branding.

## Features
- **Built-in Themes**: Ships with 11 curated themes (`VPBank Light`, `VPBank Dark`, `Default`, `Dark`, `Compact`, `Compact dark`, `Business Pro`, `Midnight Enterprise`, `VPBank`, `Tween One`, `Muse Dashboard`), with `VPBank Light` (combining the clean NocoBase Studio compact workspace with VPBank brand emerald green accents) as the default on fresh installs.
- **Component-Level Control**: Fine-tune per-component Ant Design tokens with live preview.
- **Header, Sider & Global CSS Layout Styles**: Customize NocoBase navigation bar, sidebar colors, layout dimensions (`siderWidth`, block radius, page padding), and custom `globalStyle` CSS.
- **Login Page Branding**: Customize `/signin` background, logo, card, button, app title, and favicon.
- **User Theme Preferences**: Allow users to switch between selectable themes in the User Center menu.
- **Extended Icon Picker**: Registers 315+ curated Material Design and Bootstrap icons alongside built-in Ant Design icons.

## Usage
1. Enable the plugin (it automatically disables the built-in `theme-editor` plugin to avoid conflicts).
2. Go to `Settings -> Antd Style Theme`.
3. Edit an existing theme or click `Add new theme` to create a custom theme.
4. Adjust global tokens, `Component Styles`, `Layout Styles`, or `Login Styles` and save.
5. Set a theme as the system default or mark it `User selectable` so users can choose it from User Center.
