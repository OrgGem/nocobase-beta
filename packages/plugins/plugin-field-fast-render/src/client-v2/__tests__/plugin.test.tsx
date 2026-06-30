import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TableColumnModel } from '@nocobase/client-v2';
import { describe, expect, it, vi } from 'vitest';
import PluginFieldFastRenderClient from '../plugin';
import {
  canFastRenderColumn,
  isSupportedFastRenderField,
  patchTableColumnFastRender,
  renderFastCell,
} from '../fastRender';

type TestStep = {
  defaultParams?: { fastRender?: boolean };
  handler?: (ctx: Record<string, any>, params: { fastRender?: boolean }) => void;
  hideInSettings?: (ctx: Record<string, any>) => boolean;
};

function createColumn(overrides: Record<string, any> = {}) {
  return {
    context: {
      collectionField: {
        interface: 'input',
        isAssociationField: () => false,
      },
      flowSettingsEnabled: false,
    },
    fieldPath: 'title',
    props: {
      fastRender: true,
    },
    subModels: {
      field: {
        use: 'DisplayTextFieldModel',
      },
    },
    ...overrides,
  };
}

describe('PluginFieldFastRenderClient', () => {
  it('detects supported primitive table columns', () => {
    expect(isSupportedFastRenderField(createColumn())).toBe(true);
    expect(
      isSupportedFastRenderField(
        createColumn({
          context: {
            collectionField: {
              interface: 'number',
              isAssociationField: () => false,
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isSupportedFastRenderField(
        createColumn({
          context: {
            collectionField: {
              interface: 'select',
              isAssociationField: () => false,
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isSupportedFastRenderField(
        createColumn({
          context: {
            collectionField: {
              interface: 'json',
              isAssociationField: () => false,
            },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isSupportedFastRenderField(
        createColumn({
          context: {
            collectionField: {
              interface: 'input',
              isAssociationField: () => true,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('enables fast render only for safe opt-in columns', () => {
    expect(canFastRenderColumn(createColumn())).toBe(true);
    expect(canFastRenderColumn(createColumn({ props: { fastRender: false } }))).toBe(false);
    expect(canFastRenderColumn(createColumn({ props: { fastRender: true, editable: true } }))).toBe(false);
    expect(
      canFastRenderColumn(createColumn({ context: { ...createColumn().context, flowSettingsEnabled: true } })),
    ).toBe(false);
    expect(
      canFastRenderColumn(
        createColumn({
          subModels: {
            field: {
              use: 'CustomDisplayFieldModel',
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('renders text, number, and selection cells with the fast path', () => {
    expect(renderToStaticMarkup(<>{renderFastCell(createColumn(), { title: 'Hello' })}</>)).toContain('Hello');

    const numberColumn = createColumn({
      context: {
        collectionField: {
          interface: 'number',
          isAssociationField: () => false,
        },
      },
      fieldPath: 'amount',
      props: {
        addonBefore: '$',
        fastRender: true,
        numberStep: 0.01,
      },
      subModels: {
        field: {
          use: 'DisplayNumberFieldModel',
        },
      },
    });
    expect(renderToStaticMarkup(<>{renderFastCell(numberColumn, { amount: 1234.5 })}</>)).toContain('$');
    expect(renderToStaticMarkup(<>{renderFastCell(numberColumn, { amount: 1234.5 })}</>)).toContain('1,234.50');

    const spacedNumberColumn = createColumn({
      context: {
        collectionField: {
          interface: 'number',
          isAssociationField: () => false,
        },
      },
      fieldPath: 'amount',
      props: {
        fastRender: true,
        numberStep: 0.01,
        separator: '0 0,00',
      },
      subModels: {
        field: {
          use: 'DisplayNumberFieldModel',
        },
      },
    });
    expect(renderToStaticMarkup(<>{renderFastCell(spacedNumberColumn, { amount: 1234.5 })}</>)).toContain('1 234.50');

    const selectColumn = createColumn({
      context: {
        collectionField: {
          interface: 'multipleSelect',
          isAssociationField: () => false,
        },
        t: (key: string) => (key === '{{t("Open")}}' ? 'Translated Open' : key),
      },
      fieldPath: 'status',
      props: {
        dataSource: [
          { label: '{{t("Open")}}', value: 'open', color: 'green', icon: 'CheckOutlined' },
          { label: 'Closed', value: 'closed', color: 'red' },
        ],
        fastRender: true,
      },
      subModels: {
        field: {
          use: 'DisplayEnumFieldModel',
        },
      },
    });
    const selectHtml = renderToStaticMarkup(<>{renderFastCell(selectColumn, { status: ['open', 'missing'] })}</>);
    expect(selectHtml).toContain('Translated Open');
    expect(selectHtml).toContain('missing');

    const enumColumn = createColumn({
      context: {
        collectionField: {
          interface: 'select',
          isAssociationField: () => false,
          uiSchema: {
            enum: ['draft'],
          },
        },
      },
      fieldPath: 'state',
      props: {
        fastRender: true,
      },
      subModels: {
        field: {
          use: 'DisplayEnumFieldModel',
        },
      },
    });
    expect(renderToStaticMarkup(<>{renderFastCell(enumColumn, { state: 'draft' })}</>)).toContain('draft');
  });

  it('registers a column flow and stores the fastRender prop', async () => {
    await PluginFieldFastRenderClient.prototype.load.call({} as PluginFieldFastRenderClient);
    const flow = TableColumnModel.globalFlowRegistry.getFlow('fieldFastRenderSettings');
    const step = flow?.steps?.fastRender as TestStep;
    const setProps = vi.fn();

    expect(step).toBeDefined();
    expect(step.defaultParams).toEqual({ fastRender: false });
    expect(step.hideInSettings?.({ model: createColumn() })).toBe(false);
    step.handler?.({ model: { setProps } }, { fastRender: true });
    expect(setProps).toHaveBeenCalledWith({ fastRender: true });
  });

  it('patches renderItem once and falls back when fast render is disabled', () => {
    class LocalTableColumnModel {
      props: Record<string, any>;
      context: Record<string, any>;
      fieldPath: string;
      subModels: Record<string, any>;

      constructor(props: Record<string, any>) {
        Object.assign(this, props);
      }

      renderItem() {
        return () => <span>fallback</span>;
      }
    }

    patchTableColumnFastRender(LocalTableColumnModel);
    patchTableColumnFastRender(LocalTableColumnModel);

    const disabled = new LocalTableColumnModel(createColumn({ props: { fastRender: false } }));
    expect(renderToStaticMarkup(<>{disabled.renderItem()(null, { title: 'Hello' }, 0)}</>)).toContain('fallback');

    const enabled = new LocalTableColumnModel(createColumn());
    expect(renderToStaticMarkup(<>{enabled.renderItem()(null, { title: 'Hello' }, 0)}</>)).toContain('Hello');
  });
});
