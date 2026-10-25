/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { FlowEngine } from '@nocobase/flow-engine';
import { APIClient, TableColumnModel } from '@nocobase/client-v2';
import { fireEvent, render, cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyHeaderStyleFormat, HeaderColorPicker } from '../plugin';

afterEach(cleanup);

function column() {
  const engine = new FlowEngine();
  engine.registerModels({ TableColumnModel });
  engine.context.defineProperty('api', { value: new APIClient({ storageType: 'memory' }) });
  return engine.createModel<TableColumnModel>({ use: 'TableColumnModel' });
}

describe('Header style format with actual V2 TableColumnModel', () => {
  it('keeps existing attributes, styles and handlers and passes the column to the original callback', () => {
    const model = column();
    const click = vi.fn();
    const original = vi.fn(() => ({
      className: 'core-header',
      style: { background: 'blue', color: 'green' },
      onClick: click,
      scope: 'col',
    }));
    model.setProps('onHeaderCell', original);
    applyHeaderStyleFormat(model, { headerColor: '#123456', headerWrap: true, headerAlign: 'center' });
    const input = { key: 'name' };
    const cell = model.props.onHeaderCell(input);
    expect(original).toHaveBeenCalledWith(input);
    expect(cell).toMatchObject({
      className: 'core-header nb-header-style-format-header',
      scope: 'col',
      onClick: click,
      style: { background: 'blue', color: '#123456', whiteSpace: 'normal', textAlign: 'center' },
    });
  });

  it('restores the exact original callback on reset without accumulating wrappers or styles', () => {
    const model = column();
    const original = vi.fn(() => ({ className: 'core-header', style: { whiteSpace: 'nowrap' } }));
    model.setProps('onHeaderCell', original);
    applyHeaderStyleFormat(model, { headerWrap: true, headerColor: 'red' });
    applyHeaderStyleFormat(model, { headerAlign: 'right' });
    expect(model.props.onHeaderCell({})).toEqual({
      className: 'core-header',
      style: { whiteSpace: 'nowrap', textAlign: 'right' },
    });
    expect(original).toHaveBeenCalledTimes(1);
    applyHeaderStyleFormat(model, {});
    expect(model.props.onHeaderCell).toBe(original);
  });

  it('preserves another extension installed after the previous format and keeps unformatted columns untouched', () => {
    const model = column();
    applyHeaderStyleFormat(model, { headerColor: 'red' });
    const extension = vi.fn(() => ({ role: 'columnheader', style: { padding: 10 } }));
    model.setProps('onHeaderCell', extension);
    applyHeaderStyleFormat(model, { headerAlign: 'left' });
    expect(model.props.onHeaderCell({})).toMatchObject({
      role: 'columnheader',
      style: { padding: 10, textAlign: 'left' },
    });
    applyHeaderStyleFormat(model, {});
    expect(model.props.onHeaderCell).toBe(extension);
    applyHeaderStyleFormat(model, {});
    expect(model.props.onHeaderCell).toBe(extension);
  });

  it('restores a column with no original callback to the native undefined state', () => {
    const model = column();
    applyHeaderStyleFormat(model, { headerColor: 'red' });
    applyHeaderStyleFormat(model, { headerColor: ' ', headerAlign: null, headerWrap: false });
    expect(model.props.onHeaderCell).toBeUndefined();
  });

  it('clears the saved color through the real Antd ColorPicker', () => {
    const onChange = vi.fn();
    const rendered = render(<HeaderColorPicker value="#ff0000" onChange={onChange} />);
    fireEvent.click(rendered.container.querySelector('.ant-color-picker-trigger') as HTMLElement);
    fireEvent.click(document.querySelector('.ant-color-picker-clear') as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
