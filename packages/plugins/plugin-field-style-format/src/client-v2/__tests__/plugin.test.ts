import { TableColumnModel } from '@nocobase/client-v2';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import PluginFieldStyleFormatClientV2, {
  applyFieldStyleFormatToCellProps,
  normalizeFieldStyleFormatParams,
} from '../plugin';

type TestStep = {
  defaultParams?: Record<string, unknown>;
  handler?: (ctx: { model: TestTableColumnModel }, params?: Record<string, unknown>) => void;
};

class TestTableColumnModel {
  props: {
    onCell?: (record: unknown, recordIndex?: number) => Record<string, unknown>;
  } = {};

  setProps(keyOrProps: string | Record<string, unknown>, value?: unknown) {
    if (typeof keyOrProps === 'string') {
      this.props[keyOrProps] = value as never;
      return;
    }
    this.props = {
      ...this.props,
      ...keyOrProps,
    };
  }
}

describe('PluginFieldStyleFormatClientV2', () => {
  beforeAll(async () => {
    await PluginFieldStyleFormatClientV2.prototype.load.call({} as PluginFieldStyleFormatClientV2);
  });

  it('registers the table column flow', () => {
    expect(TableColumnModel.globalFlowRegistry.getFlow('fieldStyleFormatSettings')).toBeDefined();
  });

  it('keeps default params layout-neutral', () => {
    const step = TableColumnModel.globalFlowRegistry.getFlow('fieldStyleFormatSettings')?.steps
      ?.cellStyleFormat as TestStep;

    expect(step.defaultParams).toEqual({
      padding: null,
      margin: null,
      horizontalAlign: null,
      verticalAlign: null,
    });
    expect(normalizeFieldStyleFormatParams(step.defaultParams)).toEqual({
      padding: undefined,
      margin: undefined,
      horizontalAlign: undefined,
      verticalAlign: undefined,
    });
  });

  it('merges style format with existing onCell output', () => {
    const model = new TestTableColumnModel();
    const originalOnCell = vi.fn(() => ({
      className: 'existing-cell',
      role: 'gridcell',
      style: {
        color: 'red',
      },
    }));
    model.props.onCell = originalOnCell;

    const step = TableColumnModel.globalFlowRegistry.getFlow('fieldStyleFormatSettings')?.steps
      ?.cellStyleFormat as TestStep;

    step.handler?.(
      { model },
      {
        padding: 12,
        margin: 4,
        horizontalAlign: 'center',
        verticalAlign: 'middle',
      },
    );

    const cellProps = model.props.onCell?.({ id: 1 }, 0);
    expect(originalOnCell).toHaveBeenCalledWith({ id: 1 }, 0);
    expect(cellProps?.role).toBe('gridcell');
    expect(cellProps?.className).toBe('existing-cell nb-field-style-format-cell');
    expect(cellProps?.style).toMatchObject({
      color: 'red',
      padding: 12,
      textAlign: 'center',
      verticalAlign: 'middle',
      '--nb-field-style-format-margin': '4px',
      '--nb-field-style-format-justify-content': 'center',
      '--nb-field-style-format-align-items': 'center',
    });
  });

  it('maps horizontal align values to text alignment and flex justification', () => {
    expect(applyFieldStyleFormatToCellProps({}, { horizontalAlign: 'left' }).style).toMatchObject({
      textAlign: 'left',
      '--nb-field-style-format-justify-content': 'flex-start',
    });
    expect(applyFieldStyleFormatToCellProps({}, { horizontalAlign: 'center' }).style).toMatchObject({
      textAlign: 'center',
      '--nb-field-style-format-justify-content': 'center',
    });
    expect(applyFieldStyleFormatToCellProps({}, { horizontalAlign: 'right' }).style).toMatchObject({
      textAlign: 'right',
      '--nb-field-style-format-justify-content': 'flex-end',
    });
  });

  it('does not add the content wrapper class for padding-only formatting', () => {
    const cellProps = applyFieldStyleFormatToCellProps({ className: 'existing-cell' }, { padding: 8 });

    expect(cellProps.className).toBe('existing-cell');
    expect(cellProps.style).toMatchObject({
      padding: 8,
    });
  });

  it('maps vertical align values to table-cell and content alignment', () => {
    expect(applyFieldStyleFormatToCellProps({}, { verticalAlign: 'top' }).style).toMatchObject({
      verticalAlign: 'top',
      '--nb-field-style-format-align-items': 'flex-start',
    });
    expect(applyFieldStyleFormatToCellProps({}, { verticalAlign: 'middle' }).style).toMatchObject({
      verticalAlign: 'middle',
      '--nb-field-style-format-align-items': 'center',
    });
    expect(applyFieldStyleFormatToCellProps({}, { verticalAlign: 'bottom' }).style).toMatchObject({
      verticalAlign: 'bottom',
      '--nb-field-style-format-align-items': 'flex-end',
    });
  });

  it('normalizes negative or invalid spacing values to inactive values', () => {
    expect(
      normalizeFieldStyleFormatParams({
        padding: -1,
        margin: Number.NaN,
        horizontalAlign: 'invalid' as never,
        verticalAlign: 'invalid' as never,
      }),
    ).toEqual({
      padding: undefined,
      margin: undefined,
      horizontalAlign: undefined,
      verticalAlign: undefined,
    });
  });
});
