/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { createForm } from '@formily/core';
import { FormProvider, VoidField } from '@formily/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAMESPACE } from '../../constants';
import { PostgresAddCollectionAction } from '../AddCollectionAction';
import { ConfigurationForm } from '../ConfigurationForm';
import {
  PostgresCalendarCollectionTemplate,
  PostgresFileCollectionTemplate,
  PostgresGeneralCollectionTemplate,
  PostgresSQLCollectionTemplate,
  PostgresTreeCollectionTemplate,
} from '../collection-templates';
import enUS from '../../locale/en-US.json';
import zhCN from '../../locale/zh-CN.json';

let capturedSchema: Record<string, unknown> | undefined;
let capturedScope: Record<string, unknown> | undefined;
const apiRequestSpy = vi.fn().mockResolvedValue({ data: {} });
const reloadDataSourceSpy = vi.fn().mockResolvedValue(undefined);
const refreshCMSpy = vi.fn().mockResolvedValue(undefined);
const refreshResourceSpy = vi.fn().mockResolvedValue(undefined);
const setVisibleSpy = vi.fn();

vi.mock('react-router-dom', () => ({
  useParams: () => ({ name: 'pg-v1' }),
}));

vi.mock('@nocobase/client', () => ({
  SchemaComponent: ({ schema, scope }: { schema: Record<string, unknown>; scope?: Record<string, unknown> }) => {
    capturedSchema = schema;
    capturedScope = scope;
    return null;
  },
  ActionContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  RecordProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCompile: () => (value: unknown) => String(value ?? ''),
  useRecord: () => undefined,
  useCancelAction: () => ({ run: vi.fn() }),
  useRequest: () => ({ data: undefined }),
  useAPIClient: () => ({ request: apiRequestSpy }),
  useActionContext: () => ({ setVisible: setVisibleSpy }),
  useCollectionManager_deprecated: () => ({ refreshCM: refreshCMSpy }),
  useResourceActionContext: () => ({ refresh: refreshResourceSpy }),
  useDataSourceManager: () => ({
    collectionTemplateManager: undefined,
    getDataSource: () => ({ reload: reloadDataSourceSpy }),
  }),
  CollectionTemplate: class MockCollectionTemplate {
    collectionTemplateManager: unknown;
    availableFieldInterfaces: unknown;
    configurableProperties: unknown;
    default: unknown;
    constructor(manager: unknown) {
      this.collectionTemplateManager = manager;
    }
  },
}));

afterEach(() => {
  cleanup();
  capturedSchema = undefined;
  capturedScope = undefined;
  vi.clearAllMocks();
});

function collectTranslationKeys(value: unknown, keys: Set<string>): void {
  if (typeof value === 'string') {
    const regex = /\{\{t\("([^"]+)",\s*\{\s*ns:\s*"([^"]+)"\s*\}\)\}\}/g;
    let match = regex.exec(value);
    while (match) {
      expect(match[2]).toBe(NAMESPACE);
      keys.add(match[1]);
      match = regex.exec(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTranslationKeys(item, keys);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectTranslationKeys(entry, keys);
  }
}

describe('PostgreSQL legacy client v1', () => {
  it('syncs options.addAllCollections, options.autoDiscover, and preserves selectedCollections when editing v2 data sources', async () => {
    const form = createForm({
      values: {
        options: {
          host: 'db.test',
          addAllCollections: false,
          autoDiscover: true,
          selectedCollections: ['orders', 'customers'],
        },
      },
    });

    render(
      <FormProvider form={form}>
        <ConfigurationForm from="edit" />
      </FormProvider>,
    );

    await waitFor(() => {
      expect(form.values.options.addAllCollections).toBe(false);
      expect(form.values.options.autoDiscover).toBe(false);
      expect(form.values.collections).toEqual([
        { name: 'orders', selected: true },
        { name: 'customers', selected: true },
      ]);
      expect(form.values.__postgresPreserveSelection).toBe(true);
    });

    const advanced = (
      capturedSchema as {
        properties: {
          options: { properties: { tabs: { properties: { advanced: { properties: Record<string, unknown> } } } } };
        };
      }
    ).properties.options.properties.tabs.properties.advanced.properties;
    expect(advanced.addAllCollections).toBeDefined();
    expect(advanced.autoDiscover).toBeDefined();

    cleanup();
    const createFormInstance = createForm({ values: { options: { addAllCollections: false } } });
    render(
      <FormProvider form={createFormInstance}>
        <ConfigurationForm from="create" />
      </FormProvider>,
    );
    await waitFor(() => {
      expect(createFormInstance.values.options.autoDiscover).toBe(false);
    });
    expect(createFormInstance.values.__postgresPreserveSelection).toBeUndefined();
  });

  it('defines editable query column inputs with validation on PostgresSQLCollectionTemplate', () => {
    const template = new PostgresSQLCollectionTemplate({
      dataSourceManager: {
        app: {
          i18n: {
            t: (key: string) => zhCN[key as keyof typeof zhCN] || key,
          },
        },
      },
    } as never);

    expect(template.default?.fields).toEqual([]);
    expect((template.default as { sqlFields?: unknown[] })?.sqlFields).toEqual([{ name: '', type: 'string' }]);
    const sqlFields = template.configurableProperties?.sqlFields as {
      'x-component': string;
      'x-validator': (value?: Array<{ name?: string }>) => string;
    };
    expect(sqlFields['x-component']).toBe('ArrayItems');
    expect(sqlFields['x-validator']([])).toBe(zhCN['Add at least one query column']);
    expect(sqlFields['x-validator']([{ name: '  ' }])).toBe(zhCN['Column name is required']);
    expect(sqlFields['x-validator']([{ name: 'id' }, { name: 'id' }])).toBe(zhCN['Column names must be unique']);
    expect(sqlFields['x-validator']([{ name: 'id' }, { name: 'revenue' }])).toBe('');
  });

  it('scopes all v1 schema translations to NAMESPACE and defines every key in en-US and zh-CN', () => {
    const form = createForm({ values: { options: {} } });
    render(
      <FormProvider form={form}>
        <ConfigurationForm />
      </FormProvider>,
    );

    const templates = [
      new PostgresGeneralCollectionTemplate(undefined as never),
      new PostgresCalendarCollectionTemplate(undefined as never),
      new PostgresFileCollectionTemplate(undefined as never),
      new PostgresTreeCollectionTemplate(undefined as never),
      new PostgresSQLCollectionTemplate(undefined as never),
    ];

    const keys = new Set<string>();
    collectTranslationKeys(capturedSchema, keys);
    for (const template of templates) {
      collectTranslationKeys(template.title, keys);
      collectTranslationKeys(template.description, keys);
      collectTranslationKeys(template.configurableProperties, keys);
      collectTranslationKeys(template.default, keys);
    }

    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      expect(enUS).toHaveProperty([key]);
      expect(zhCN).toHaveProperty([key]);
    }
  });

  it('maps sqlFields into fields and refreshes ResourceActionContext after v1 collection creation', async () => {
    const form = createForm({
      values: {
        name: 'sales_report',
        title: 'Sales Report',
        template: 'sql',
        sql: 'SELECT id, total FROM orders',
        sqlFields: [
          { name: ' id ', type: 'integer' },
          { name: 'total', type: 'decimal' },
        ],
      },
    });
    form.createVoidField({ name: 'submitBtn' });

    function Harness() {
      const useCreate = capturedScope?.useCreatePostgresCollection as (() => { run: () => Promise<void> }) | undefined;
      const action = useCreate?.();
      return (
        <button type="button" onClick={() => action?.run()}>
          RunCreate
        </button>
      );
    }

    render(<PostgresAddCollectionAction />);
    expect(typeof capturedScope?.useCreatePostgresCollection).toBe('function');

    render(
      <FormProvider form={form}>
        <VoidField name="submitBtn">
          <Harness />
        </VoidField>
      </FormProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'RunCreate' }));

    await waitFor(() => {
      expect(apiRequestSpy).toHaveBeenCalledWith({
        url: 'dataSources/pg-v1/collections:create',
        method: 'post',
        data: expect.objectContaining({
          name: 'sales_report',
          template: 'sql',
          sql: 'SELECT id, total FROM orders',
          fields: [
            { name: 'id', type: 'integer', interface: 'integer' },
            { name: 'total', type: 'decimal', interface: 'number' },
          ],
        }),
      });
    });
    const sentData = apiRequestSpy.mock.calls[0][0].data as Record<string, unknown>;
    expect('sqlFields' in sentData).toBe(false);
    expect(reloadDataSourceSpy).toHaveBeenCalledOnce();
    expect(refreshCMSpy).toHaveBeenCalledOnce();
    expect(refreshResourceSpy).toHaveBeenCalledOnce();
  });
});
