import { Plugin, TableColumnModel } from '@nocobase/client-v2';
import type React from 'react';
import { tExpr } from './locale';

export type HorizontalAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

export type FieldStyleFormatParams = {
  padding?: number | null;
  margin?: number | null;
  horizontalAlign?: HorizontalAlign | null;
  verticalAlign?: VerticalAlign | null;
};

type CellPropsLike = {
  className?: string;
  style?: React.CSSProperties;
  [key: string]: unknown;
};

type TableColumnModelLike = TableColumnModel & {
  props: {
    onCell?: OnCellHandler;
  };
  setProps: (keyOrProps: string | Record<string, unknown>, value?: unknown) => void;
};

type OnCellHandler = (record: unknown, recordIndex?: number) => CellPropsLike | undefined;

const FLOW_KEY = 'fieldStyleFormatSettings';
const STEP_KEY = 'cellStyleFormat';
const CELL_CLASS_NAME = 'nb-field-style-format-cell';
const STYLE_ELEMENT_ID = 'nb-field-style-format-style';
const originalOnCellHandlers = new WeakMap<object, OnCellHandler | undefined>();

function normalizeSpacing(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeHorizontalAlign(value: unknown): HorizontalAlign | undefined {
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

function normalizeVerticalAlign(value: unknown): VerticalAlign | undefined {
  return value === 'top' || value === 'middle' || value === 'bottom' ? value : undefined;
}

function horizontalToJustifyContent(value?: HorizontalAlign) {
  if (value === 'center') {
    return 'center';
  }
  if (value === 'right') {
    return 'flex-end';
  }
  if (value === 'left') {
    return 'flex-start';
  }
  return undefined;
}

function verticalToAlignItems(value?: VerticalAlign) {
  if (value === 'middle') {
    return 'center';
  }
  if (value === 'bottom') {
    return 'flex-end';
  }
  if (value === 'top') {
    return 'flex-start';
  }
  return undefined;
}

export function normalizeFieldStyleFormatParams(params?: FieldStyleFormatParams): FieldStyleFormatParams {
  return {
    padding: normalizeSpacing(params?.padding),
    margin: normalizeSpacing(params?.margin),
    horizontalAlign: normalizeHorizontalAlign(params?.horizontalAlign),
    verticalAlign: normalizeVerticalAlign(params?.verticalAlign),
  };
}

function hasActiveFormat(params: FieldStyleFormatParams) {
  return (
    typeof params.padding === 'number' ||
    typeof params.margin === 'number' ||
    !!params.horizontalAlign ||
    !!params.verticalAlign
  );
}

function mergeClassName(className?: string) {
  return [className, CELL_CLASS_NAME].filter(Boolean).join(' ');
}

export function applyFieldStyleFormatToCellProps(
  cellProps: CellPropsLike | undefined,
  params: FieldStyleFormatParams,
): CellPropsLike {
  const normalized = normalizeFieldStyleFormatParams(params);
  if (!hasActiveFormat(normalized)) {
    return cellProps || {};
  }

  const style: React.CSSProperties & Record<string, string | number | undefined> = {
    ...(cellProps?.style || {}),
  };
  const justifyContent = horizontalToJustifyContent(normalized.horizontalAlign);
  const alignItems = verticalToAlignItems(normalized.verticalAlign);
  const shouldFormatContentWrapper =
    typeof normalized.margin === 'number' || !!normalized.horizontalAlign || !!normalized.verticalAlign;

  if (typeof normalized.padding === 'number') {
    style.padding = normalized.padding;
  }
  if (normalized.horizontalAlign) {
    style.textAlign = normalized.horizontalAlign;
  }
  if (normalized.verticalAlign) {
    style.verticalAlign = normalized.verticalAlign;
  }
  if (typeof normalized.margin === 'number') {
    style['--nb-field-style-format-margin'] = `${normalized.margin}px`;
  }
  if (justifyContent) {
    style['--nb-field-style-format-justify-content'] = justifyContent;
  }
  if (alignItems) {
    style['--nb-field-style-format-align-items'] = alignItems;
  }

  return {
    ...(cellProps || {}),
    className: shouldFormatContentWrapper ? mergeClassName(cellProps?.className) : cellProps?.className,
    style,
  };
}

function getOriginalOnCell(model: TableColumnModelLike) {
  if (!originalOnCellHandlers.has(model)) {
    originalOnCellHandlers.set(model, model.props.onCell);
  }
  return originalOnCellHandlers.get(model);
}

function applyFieldStyleFormat(model: TableColumnModelLike, params?: FieldStyleFormatParams) {
  const normalized = normalizeFieldStyleFormatParams(params);
  const originalOnCell = getOriginalOnCell(model);

  if (!hasActiveFormat(normalized)) {
    model.setProps('onCell', originalOnCell);
    return;
  }

  model.setProps('onCell', (record: unknown, recordIndex?: number) => {
    const originalCellProps = originalOnCell?.(record, recordIndex);
    return applyFieldStyleFormatToCellProps(originalCellProps, normalized);
  });
}

export function ensureFieldStyleFormatStyleElement() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
.${CELL_CLASS_NAME} > div {
  margin: var(--nb-field-style-format-margin, 0);
  display: flex;
  justify-content: var(--nb-field-style-format-justify-content, flex-start);
  align-items: var(--nb-field-style-format-align-items, flex-start);
  min-height: 100%;
}
`;
  document.head.appendChild(style);
}

TableColumnModel.registerFlow({
  key: FLOW_KEY,
  sort: 506,
  title: tExpr('Field style format'),
  steps: {
    [STEP_KEY]: {
      title: tExpr('Cell style format'),
      uiSchema: {
        padding: {
          type: 'number',
          title: tExpr('Padding'),
          'x-decorator': 'FormItem',
          'x-component': 'NumberPicker',
          'x-component-props': {
            min: 0,
            precision: 0,
            addonAfter: 'px',
            style: { width: '100%' },
          },
        },
        margin: {
          type: 'number',
          title: tExpr('Margin'),
          'x-decorator': 'FormItem',
          'x-component': 'NumberPicker',
          'x-component-props': {
            min: 0,
            precision: 0,
            addonAfter: 'px',
            style: { width: '100%' },
          },
        },
        horizontalAlign: {
          type: 'string',
          title: tExpr('Horizontal align'),
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { label: tExpr('Default'), value: null },
            { label: tExpr('Left'), value: 'left' },
            { label: tExpr('Center'), value: 'center' },
            { label: tExpr('Right'), value: 'right' },
          ],
        },
        verticalAlign: {
          type: 'string',
          title: tExpr('Vertical align'),
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { label: tExpr('Default'), value: null },
            { label: tExpr('Top'), value: 'top' },
            { label: tExpr('Middle'), value: 'middle' },
            { label: tExpr('Bottom'), value: 'bottom' },
          ],
        },
      },
      defaultParams: {
        padding: null,
        margin: null,
        horizontalAlign: null,
        verticalAlign: null,
      },
      handler(ctx, params: FieldStyleFormatParams) {
        applyFieldStyleFormat(ctx.model as TableColumnModelLike, params);
      },
    },
  },
});

export class PluginFieldStyleFormatClientV2 extends Plugin {
  async load() {
    ensureFieldStyleFormatStyleElement();
  }
}

export default PluginFieldStyleFormatClientV2;
