/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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

export function HeaderColorPicker({ value, onChange }: HeaderColorPickerProps) {
  return (
    <ColorPicker
      allowClear
      showText
      value={value || undefined}
      onChange={(color) => onChange?.(color?.toHexString())}
      onClear={() => onChange?.(undefined)}
    />
  );
}

type HeaderCellProps = React.HTMLAttributes<HTMLTableCellElement> & Record<string, unknown>;
type HeaderCellHandler = (column: unknown) => HeaderCellProps | undefined;

type TableColumnModelLike = TableColumnModel & {
  props: { onHeaderCell?: HeaderCellHandler };
  setProps: (keyOrProps: string | Record<string, unknown>, value?: unknown) => void;
};

const FLOW_KEY = 'headerStyleFormatSettings';
const STEP_KEY = 'headerStyleFormat';
const HEADER_CLASS_NAME = 'nb-header-style-format-header';
const STYLE_ELEMENT_ID = 'nb-header-style-format-style';
const headerHandlers = new WeakMap<object, { original?: HeaderCellHandler; applied: HeaderCellHandler }>();

function normalizeColor(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
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

export function applyHeaderStyleFormat(model: TableColumnModelLike, params?: HeaderStyleFormatParams): void {
  const normalized = normalizeHeaderStyleFormatParams(params);
  const previous = headerHandlers.get(model);
  const current = model.props.onHeaderCell;
  const original = previous && current === previous.applied ? previous.original : current;

  if (!hasActiveFormat(normalized)) {
    if (previous && current === previous.applied) model.setProps('onHeaderCell', original);
    headerHandlers.delete(model);
    return;
  }

  const applied: HeaderCellHandler = (column) => {
    const cell = original?.(column);
    const style: React.CSSProperties = { ...cell?.style };

    if (normalized.headerColor) {
      style.color = normalized.headerColor;
    }

    if (normalized.headerAlign) {
      style.textAlign = normalized.headerAlign;
    }

    if (normalized.headerWrap) {
      style.whiteSpace = 'normal';
    }

    return {
      ...cell,
      style,
      className:
        [cell?.className, normalized.headerWrap ? HEADER_CLASS_NAME : undefined].filter(Boolean).join(' ') || undefined,
    };
  };
  headerHandlers.set(model, { original, applied });
  model.setProps('onHeaderCell', applied);
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
