/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import NativeManager from '@nocobase/plugin-data-source-manager/client-v2';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_SOURCE_TYPE, NAMESPACE } from '../../constants';
import { toCollectionOptions } from '../collection-options';
import { PostgresAddCollection } from '../PostgresAddCollection';
import PostgresConfigForm from '../PostgresConfigForm';
import { PostgresDeleteCollection } from '../PostgresDeleteCollection';
import Plugin from '../plugin';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

function registerPostgresType() {
  const app = createMockClient();
  app.flowEngine.context.defineProperty('message', { value: { error: vi.fn() } });
  const manager = new NativeManager({}, app);
  vi.spyOn(app.pm, 'get').mockReturnValue(manager);
  return { app, manager };
}

describe('PostgreSQL native client v2', () => {
  it('registers the datasource type and preserves legacy selected-table settings', async () => {
    expect(NAMESPACE).toBe('plugin-data-source-postgres');
    const { app, manager } = registerPostgresType();
    await new Plugin({}, app).load();

    const type = manager.getType(DATA_SOURCE_TYPE);
    expect(type.SettingsForm).toBeDefined();
    expect(type.defaultValues).toMatchObject({
      options: {
        host: 'localhost',
        port: 5432,
        schema: 'public',
        ssl: false,
        addAllCollections: true,
      },
    });
    expect(type.AddCollection).toBe(PostgresAddCollection);
    expect(type.DeleteCollection).toBe(PostgresDeleteCollection);
    expect(type.allowCollectionCreate).toBe(true);
    expect(type.allowCollectionDeletion).toBe(true);
    expect(typeof type.createFieldInterfaces).toBe('function');
    const tableFilter = (
      type.createFieldInterfaces as (ctx: { collection: Record<string, unknown> }) => Record<string, unknown>
    )({
      collection: { name: 'orders', template: 'general' },
    });
    expect(tableFilter.exclude).toEqual(
      expect.arrayContaining(['formula', 'sequence', 'tableoid', 'createdBy', 'attachment']),
    );
    const viewFilter = (
      type.createFieldInterfaces as (ctx: { collection: Record<string, unknown> }) => Record<string, unknown>
    )({
      collection: { name: 'order_view', view: true, template: 'view' },
    });
    expect(viewFilter).toEqual({ include: ['__none__'] });

    const legacy = type.normalizeValues({
      options: { autoDiscover: false },
      __postgresPreserveLegacySelection: true,
    });
    expect(legacy.collections).toBeUndefined();
    expect(legacy.options).toMatchObject({ addAllCollections: false, autoDiscover: false });
    expect(legacy.options.selectedCollections).toBeUndefined();

    const selected = type.normalizeValues({ options: { addAllCollections: false }, collections: ['orders'] });
    expect(selected.options.selectedCollections).toEqual(['orders']);
  });

  it('reads available tables when opening the setup selection and keeps SSL CA options without initialValue warnings', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources:readTables').reply(200, { data: [{ name: 'orders' }] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <Form
          initialValues={{
            key: 'external',
            options: {
              host: 'db.test',
              port: 5432,
              database: 'sales',
              username: 'postgres',
              password: 'secret',
              ssl: true,
              sslCa: 'test certificate',
              addAllCollections: false,
            },
          }}
        >
          <PostgresConfigForm mode="create" type={{ label: 'PostgreSQL' }} loadCollections={vi.fn()} />
        </Form>
      </FlowEngineProvider>,
    );

    expect(screen.getByLabelText('CA certificate (PEM)')).toBeTruthy();
    fireEvent.focus(await screen.findByRole('combobox'));
    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(1));

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String);
    expect(logged.some((line) => line.includes("already set 'initialValues'"))).toBe(false);

    expect(JSON.parse(app.apiMock.history.post[0].data)).toMatchObject({
      dataSourceKey: 'external',
      dbOptions: {
        type: DATA_SOURCE_TYPE,
        host: 'db.test',
        database: 'sales',
        ssl: true,
        sslCa: 'test certificate',
      },
    });
  });

  it('uses loadCollections in edit mode when saved options omit default schema and ssl', async () => {
    const { app } = registerPostgresType();
    const loadCollections = vi.fn().mockResolvedValue([{ name: 'orders' }]);
    const savedInitial = {
      key: 'legacy',
      options: {
        host: 'db.test',
        port: 5432,
        database: 'sales',
        username: 'postgres',
        addAllCollections: false,
      },
    };

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <Form initialValues={savedInitial}>
          <PostgresConfigForm
            mode="edit"
            type={{ label: 'PostgreSQL' }}
            initialValues={savedInitial}
            loadCollections={loadCollections}
          />
        </Form>
      </FlowEngineProvider>,
    );

    fireEvent.focus(await screen.findByRole('combobox'));
    await waitFor(() => expect(loadCollections).toHaveBeenCalledWith('legacy'));
    expect(app.apiMock.history.post).toHaveLength(0);
  });

  it('maps discovered tables and views into import selection options', () => {
    expect(toCollectionOptions([{ name: 'orders' }, { name: 'active_orders' }])).toEqual([
      { label: 'orders', value: 'orders' },
      { label: 'active_orders', value: 'active_orders' },
    ]);
  });

  it('creates a native calendar collection with PostgreSQL-compatible field definitions', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources/external/collections:create').reply(200, { data: {} });
    const submitted = vi.fn();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <PostgresAddCollection dataSourceKey="external" onSubmitted={submitted} />
      </FlowEngineProvider>,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: /Add collection/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create collection' }));
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'events' } });
    fireEvent.change(screen.getByLabelText('Collection display name'), { target: { value: 'Events' } });

    const template = screen.getByLabelText('Collection template');
    fireEvent.mouseDown(template);
    fireEvent.click(await screen.findByText('Calendar collection'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    const payload = JSON.parse(app.apiMock.history.post[0].data);
    expect(payload).toMatchObject({ name: 'events', title: 'Events', template: 'calendar' });
    expect(payload.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'start', type: 'date', interface: 'datetime' }),
        expect.objectContaining({ name: 'end', type: 'date', interface: 'datetime' }),
      ]),
    );
  });

  it('creates a general collection with an identity key and timestamp fields', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources/external/collections:create').reply(200, { data: {} });
    const submitted = vi.fn();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <PostgresAddCollection dataSourceKey="external" onSubmitted={submitted} />
      </FlowEngineProvider>,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: /Add collection/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create collection' }));
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'notes' } });
    fireEvent.change(screen.getByLabelText('Collection display name'), { target: { value: 'Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    const payload = JSON.parse(app.apiMock.history.post[0].data);
    expect(payload).toMatchObject({
      name: 'notes',
      title: 'Notes',
      template: 'general',
      autoGenId: true,
      createdAt: true,
      updatedAt: true,
    });
    expect(payload.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true }),
        expect.objectContaining({ name: 'createdAt', type: 'date' }),
        expect.objectContaining({ name: 'updatedAt', type: 'date' }),
      ]),
    );
  });

  it('creates a file collection with PostgreSQL-compatible file metadata fields', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources/external/collections:create').reply(200, { data: {} });
    const submitted = vi.fn();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <PostgresAddCollection dataSourceKey="external" onSubmitted={submitted} />
      </FlowEngineProvider>,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: /Add collection/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create collection' }));
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'attachments' } });
    fireEvent.change(screen.getByLabelText('Collection display name'), { target: { value: 'Attachments' } });
    fireEvent.mouseDown(screen.getByLabelText('Collection template'));
    fireEvent.click(await screen.findByText('File collection'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    const payload = JSON.parse(app.apiMock.history.post[0].data);
    expect(payload).toMatchObject({ name: 'attachments', title: 'Attachments', template: 'file' });
    expect(payload.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true }),
        expect.objectContaining({ name: 'filename', type: 'string' }),
        expect.objectContaining({ name: 'title', type: 'string' }),
        expect.objectContaining({ name: 'url', type: 'string', interface: 'url' }),
        expect.objectContaining({ name: 'mimetype', type: 'string' }),
        expect.objectContaining({ name: 'size', type: 'bigInt' }),
      ]),
    );
  });

  it('creates read-only SQL collections with declared query fields', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources/external/collections:create').reply(200, { data: {} });
    const submitted = vi.fn();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <PostgresAddCollection dataSourceKey="external" onSubmitted={submitted} />
      </FlowEngineProvider>,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: /Add collection/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create collection' }));
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'query_results' } });
    fireEvent.change(screen.getByLabelText('Collection display name'), { target: { value: 'Query results' } });
    fireEvent.mouseDown(screen.getByLabelText('Collection template'));
    fireEvent.click(await screen.findByText('SQL collection'));
    fireEvent.change(screen.getByLabelText('SQL query'), {
      target: { value: "SELECT 1 AS id, 'row' AS value" },
    });
    fireEvent.change(screen.getByLabelText('Column name 1'), { target: { value: 'id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    const payload = JSON.parse(app.apiMock.history.post[0].data);
    expect(payload).toMatchObject({
      name: 'query_results',
      template: 'sql',
      autoGenId: false,
      createdAt: false,
      updatedAt: false,
      sql: "SELECT 1 AS id, 'row' AS value",
    });
    expect(payload.fields).toEqual([expect.objectContaining({ name: 'id', type: 'string' })]);
  });

  it('creates tree collections with a self-referencing parent field', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources/external/collections:create').reply(200, { data: {} });
    const submitted = vi.fn();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <PostgresAddCollection dataSourceKey="external" onSubmitted={submitted} />
      </FlowEngineProvider>,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: /Add collection/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Create collection' }));
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'categories' } });
    fireEvent.change(screen.getByLabelText('Collection display name'), { target: { value: 'Categories' } });
    fireEvent.mouseDown(screen.getByLabelText('Collection template'));
    fireEvent.click(await screen.findByText('Tree collection'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    const payload = JSON.parse(app.apiMock.history.post[0].data);
    expect(payload).toMatchObject({ name: 'categories', template: 'tree', tree: 'parentId' });
    expect(payload.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'parentId', type: 'bigInt' }),
        expect.objectContaining({ name: 'parent', type: 'belongsTo', target: 'categories', foreignKey: 'parentId' }),
        expect.objectContaining({ name: 'children', type: 'hasMany', target: 'categories', foreignKey: 'parentId' }),
      ]),
    );
  });

  it('leaves cascade off by default for collection deletion', async () => {
    const { app } = registerPostgresType();
    app.apiMock.onPost('dataSources/external/collections:destroy').reply(200, { data: {} });
    const submitted = vi.fn();

    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <PostgresDeleteCollection dataSourceKey="external" record={{ name: 'orders' }} onSubmitted={submitted} />
      </FlowEngineProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /OK/i }));

    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(app.apiMock.history.post[0].params).toEqual({ filterByTk: ['orders'], cascade: false });
  });
});
