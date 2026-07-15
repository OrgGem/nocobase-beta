import { Plugin, TableColumnModel } from '@nocobase/client-v2';
import { ColorPicker } from 'antd';
import React from 'react';
import { tExpr } from './locale';

export type HeaderAlign = 'left' | 'center' | 'right';

export type HeaderStyleFormatParams = {
  headerColor?: string | null;
  headerWrap?: boolean;
  headerAlign?: HeaderAlign | null;
};

type HeaderColorPickerProps = {
  value?: string;
  onChange?: (value?: string) => void;
};

function HeaderColorPicker({ value, onChange }: HeaderColorPickerProps) {
  return <ColorPicker allowClear showText value={value} onChange={(color) => onChange?.(color?.toHexString())} />;
}

type TableColumnModelLike = TableColumnModel & {
  setProps: (keyOrProps: string | Record<string, unknown>, value?: unknown) => void;
};

const FLOW_KEY = 'headerStyleFormatSettings';
const STEP_KEY = 'headerStyleFormat';
const HEADER_CLASS_NAME = 'nb-header-style-format-header';
const STYLE_ELEMENT_ID = 'nb-header-style-format-style';

function normalizeColor(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

function normalizeAlign(value: unknown): HeaderAlign | undefined {
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

export function normalizeHeaderStyleFormatParams(params?: HeaderStyleFormatParams): HeaderStyleFormatParams {
  return {
    headerColor: normalizeColor(params?.headerColor),
    headerWrap: !!params?.headerWrap,
    headerAlign: normalizeAlign(params?.headerAlign),
  };
}

function hasActiveFormat(params: HeaderStyleFormatParams): boolean {
  return !!params.headerColor || !!params.headerWrap || !!params.headerAlign;
}

function applyHeaderStyleFormat(model: TableColumnModelLike, params?: HeaderStyleFormatParams): void {
  const normalized = normalizeHeaderStyleFormatParams(params);

  if (!hasActiveFormat(normalized)) {
    model.setProps('onHeaderCell', undefined);
    return;
  }

  model.setProps('onHeaderCell', () => {
    const style: React.CSSProperties = {};
    let className: string | undefined;

    if (normalized.headerColor) {
      style.color = normalized.headerColor;
    }

    if (normalized.headerAlign) {
      style.textAlign = normalized.headerAlign;
    }

    if (normalized.headerWrap) {
      style.whiteSpace = 'normal';
      className = HEADER_CLASS_NAME;
    }

    return { style, className };
  });
}

export function ensureHeaderStyleFormatStyleElement(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
.${HEADER_CLASS_NAME},
.${HEADER_CLASS_NAME} * {
  white-space: normal !important;
  overflow: visible !important;
}
`;
  document.head.appendChild(style);
}

TableColumnModel.registerFlow({
  key: FLOW_KEY,
  sort: 504,
  title: tExpr('Header style format'),
  steps: {
    [STEP_KEY]: {
      title: tExpr('Header style format'),
      uiSchema: {
        headerColor: {
          type: 'string',
          title: tExpr('Header color'),
          'x-decorator': 'FormItem',
          'x-component': HeaderColorPicker,
        },
        headerWrap: {
          type: 'boolean',
          title: tExpr('Header wrap'),
          'x-decorator': 'FormItem',
          'x-component': 'Switch',
        },
        headerAlign: {
          type: 'string',
          title: tExpr('Header align'),
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { label: tExpr('Default'), value: null },
            { label: tExpr('Left'), value: 'left' },
            { label: tExpr('Center'), value: 'center' },
            { label: tExpr('Right'), value: 'right' },
          ],
        },
      },
      defaultParams: {
        headerColor: null,
        headerWrap: false,
        headerAlign: null,
      },
      handler(ctx, params: HeaderStyleFormatParams) {
        applyHeaderStyleFormat(ctx.model as TableColumnModelLike, params);
      },
    },
  },
});

export class PluginHeaderStyleFormatClientV2 extends Plugin {
  async load() {
    ensureHeaderStyleFormatStyleElement();
  }
}

export default PluginHeaderStyleFormatClientV2;
