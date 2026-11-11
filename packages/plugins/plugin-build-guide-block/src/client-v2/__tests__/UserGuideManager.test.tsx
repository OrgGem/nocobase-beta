/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { App } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserGuideManager } from '../UserGuideManager';

const mocks = vi.hoisted(() => {
  const runApi = { getStatus: vi.fn(), cancel: vi.fn(), retry: vi.fn() };
  const spaceApi = { list: vi.fn(), get: vi.fn(), build: vi.fn(), create: vi.fn(), update: vi.fn(), destroy: vi.fn() };
  const aiApi = { listLLMServices: vi.fn(), listModels: vi.fn() };
  const attachmentApi = { list: vi.fn(), get: vi.fn() };
  const storageApi = { check: vi.fn() };
  const fileManager = { uploadFile: vi.fn() };
  const apiClient = {
    resource: vi.fn((name: string) => {
      if (name === 'aiBuildGuideSpaces') return spaceApi;
      if (name === 'aiBuildGuideRuns') return runApi;
      if (name === 'attachments') return attachmentApi;
      if (name === 'storages') return storageApi;
      return aiApi;
    }),
  };
  const t = (key: string, values?: Record<string, string | number>) =>
    values ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name])) : key;
  return { runApi, spaceApi, aiApi, attachmentApi, storageApi, fileManager, apiClient, t };
});

vi.mock('@nocobase/client-v2', () => ({
  useApp: () => ({
    apiClient: mocks.apiClient,
    pm: { get: () => mocks.fileManager },
    getHref: (path: string) => `/modern${path}`,
  }),
}));
vi.mock('antd', async (importActual) => {
  const actual = await importActual<typeof import('antd')>();
  const ReactModule = await import('react');
  type SelectProps = React.ComponentProps<typeof actual.Select>;
  const NativeSelectForTest = (props: SelectProps) => {
    const isTestSelect =
      props['aria-label'] === 'Choose documents' || props.id === 'llmService' || props.id === 'model';
    if (!isTestSelect) return ReactModule.createElement(actual.Select, props);
    const multiple = props.mode === 'multiple';
    const optionElements = (props.options || []).map((option) =>
      ReactModule.createElement('option', { key: String(option.value), value: String(option.value) }, option.label),
    );
    const onChange = (event: import('react').ChangeEvent<HTMLSelectElement>) => {
      const selected = Array.from(event.currentTarget.selectedOptions).map(
        (element) => props.options?.find((option) => String(option.value) === element.value),
      );
      const value = selected.map((option) => option?.value).filter((item) => item !== undefined);
      const change = props.onChange as ((value: unknown, option: unknown) => void) | undefined;
      if (!change) return;
      if (multiple) change(value, selected);
      else change(value[0], selected[0]);
    };
    return ReactModule.createElement(
      'select',
      {
        id: props.id,
        'aria-label': props['aria-label'],
        disabled: props.disabled,
        multiple,
        value: multiple
          ? Array.isArray(props.value)
            ? props.value.map(String)
            : []
          : props.value == null
            ? ''
            : String(props.value),
        onFocus: props.onFocus,
        onChange,
      },
      optionElements,
    );
  };
  return { ...actual, Select: NativeSelectForTest };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));

function makeAttachment(id: number, filename: string) {
  return {
    id,
    updatedAt: '2026-11-12T00:00:00.000Z',
    filename,
    mimetype: 'application/pdf',
    extname: '.pdf',
    url: `/storage/${id}`,
    storageId: 9,
  };
}

describe('Build Guide modern manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spaceApi.list.mockResolvedValue({
      data: { data: [{ id: 5, title: 'Guide', engine: 'workflow', latestRunId: 'run-5', status: 'building' }] },
    });
    mocks.runApi.getStatus.mockResolvedValue({
      data: {
        data: {
          id: 'run-5',
          spaceId: 5,
          engine: 'workflow',
          status: 'running',
          stage: 'writing_chapter',
          expectedCount: 2,
          completedCount: 1,
          canCancel: true,
          canRetry: false,
          executionId: 17,
          steps: [],
        },
      },
    });
    mocks.aiApi.listLLMServices.mockResolvedValue({ data: { data: [] } });
    mocks.aiApi.listModels.mockResolvedValue({ data: { data: [] } });
    mocks.attachmentApi.list.mockResolvedValue({ data: { data: [] } });
    mocks.attachmentApi.get.mockImplementation(({ filterByTk }: { filterByTk: number }) =>
      Promise.resolve({ data: { data: { id: filterByTk, filename: `Document-${filterByTk}.pdf` } } }),
    );
    mocks.storageApi.check.mockResolvedValue({
      data: { data: { isSupportToUploadFiles: true, storage: { id: 9, type: 'local', rules: { size: 2048 } } } },
    });
    mocks.fileManager.uploadFile.mockResolvedValue({ data: { id: 44 } });
  });

  afterEach(cleanup);

  it('renders run progress and uses the modern execution route only when provided', async () => {
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    expect(await screen.findByText('1 of 2 chapters')).toBeInTheDocument();
    expect(mocks.runApi.getStatus).toHaveBeenCalledWith({ filterByTk: 'run-5' });
    expect(screen.getByRole('link', { name: 'Open execution' })).toHaveAttribute(
      'href',
      '/modern/admin/workflow/executions/17',
    );
    expect(screen.getByRole('button', { name: 'Cancel build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.spaceApi.list).toHaveBeenCalled());
  });

  it('creates with a selected document and a file-manager upload', async () => {
    const existing = makeAttachment(31, 'Existing.pdf');
    const uploaded = makeAttachment(44, 'Uploaded.pdf');
    mocks.aiApi.listLLMServices.mockResolvedValue({ data: { data: [{ name: 'openai', title: 'OpenAI' }] } });
    mocks.aiApi.listModels.mockResolvedValue({ data: { data: [{ id: 'gpt-4' }] } });
    mocks.attachmentApi.list.mockResolvedValue({ data: { data: [existing] } });
    mocks.attachmentApi.get.mockImplementation(({ filterByTk }: { filterByTk: number }) =>
      Promise.resolve({ data: { data: filterByTk === 44 ? uploaded : existing } }),
    );
    mocks.spaceApi.create.mockResolvedValue({ data: { data: { id: 8 } } });
    const user = userEvent.setup();
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    await user.click(screen.getByRole('button', { name: /Create space/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'New guide' } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'LLM Service' }), 'openai');
    await waitFor(() => expect(mocks.aiApi.listModels).toHaveBeenCalledWith({ llmService: 'openai' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'gpt-4');
    await user.selectOptions(screen.getByRole('listbox', { name: 'Choose documents' }), '31');
    await waitFor(() =>
      expect(mocks.attachmentApi.get).toHaveBeenCalledWith({
        filterByTk: 31,
        fields: ['id', 'updatedAt', 'filename', 'mimetype', 'extname', 'url', 'storageId'],
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled());

    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(['guide'], 'Uploaded.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(mocks.fileManager.uploadFile).toHaveBeenCalledWith({
        file: expect.any(File),
        fileCollectionName: 'attachments',
        storageId: 9,
        storageType: 'local',
        storageRules: { size: 2048 },
      }),
    );
    await waitFor(() => expect(screen.getByText('Uploaded.pdf')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(mocks.spaceApi.create).toHaveBeenCalledWith({
        values: expect.objectContaining({ documents: [{ id: 31 }, { id: 44 }] }),
      }),
    );
  });

  it('loads existing document IDs on edit and keeps them when adding another ACL-readable document', async () => {
    const existing = makeAttachment(31, 'Existing.pdf');
    const added = makeAttachment(32, 'Added.pdf');
    mocks.spaceApi.list.mockResolvedValue({
      data: { data: [{ id: 5, title: 'Guide', llmService: 'openai', model: 'gpt-4', outputFormat: 'html' }] },
    });
    mocks.spaceApi.get.mockResolvedValue({ data: { data: { id: 5, documents: [{ id: 31 }] } } });
    mocks.attachmentApi.list.mockResolvedValue({ data: { data: [added] } });
    mocks.attachmentApi.get.mockImplementation(({ filterByTk }: { filterByTk: number }) =>
      Promise.resolve({ data: { data: filterByTk === 31 ? existing : added } }),
    );
    mocks.aiApi.listLLMServices.mockResolvedValue({ data: { data: [{ name: 'openai', title: 'OpenAI' }] } });
    mocks.aiApi.listModels.mockResolvedValue({ data: { data: [{ id: 'gpt-4' }] } });
    const user = userEvent.setup();
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Existing.pdf')).toBeInTheDocument();
    expect(mocks.spaceApi.get).toHaveBeenCalledWith({
      filterByTk: 5,
      fields: ['id', 'documents.id'],
      appends: ['documents'],
    });
    await user.selectOptions(screen.getByRole('listbox', { name: 'Choose documents' }), '32');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(mocks.spaceApi.update).toHaveBeenCalledWith({
        filterByTk: 5,
        values: expect.objectContaining({ documents: [{ id: 31 }, { id: 32 }] }),
      }),
    );
  });

  it('refuses to select a list row that attachments:get does not authorize', async () => {
    mocks.attachmentApi.list.mockResolvedValue({ data: { data: [{ id: 99, filename: 'Not-readable.pdf' }] } });
    mocks.attachmentApi.get.mockRejectedValue(new Error('Forbidden'));
    const user = userEvent.setup();
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    await user.click(screen.getByRole('button', { name: /Create space/ }));
    await user.selectOptions(screen.getByRole('listbox', { name: 'Choose documents' }), '99');

    await waitFor(() =>
      expect(mocks.attachmentApi.get).toHaveBeenCalledWith({
        filterByTk: 99,
        fields: ['id', 'updatedAt', 'filename', 'mimetype', 'extname', 'url', 'storageId'],
      }),
    );
    expect(
      (screen.getByRole('listbox', { name: 'Choose documents' }) as HTMLSelectElement).selectedOptions,
    ).toHaveLength(0);
    expect(mocks.spaceApi.create).not.toHaveBeenCalled();
  });

  it('rejects an attachment GET response that omits Build-required fields', async () => {
    const listed = makeAttachment(99, 'Scoped.pdf');
    mocks.attachmentApi.list.mockResolvedValue({ data: { data: [listed] } });
    mocks.attachmentApi.get.mockResolvedValue({ data: { data: { id: 99, filename: 'Scoped.pdf' } } });
    const user = userEvent.setup();
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    await user.click(screen.getByRole('button', { name: /Create space/ }));
    await user.selectOptions(screen.getByRole('listbox', { name: 'Choose documents' }), '99');

    await waitFor(() =>
      expect(mocks.attachmentApi.get).toHaveBeenCalledWith({
        filterByTk: 99,
        fields: ['id', 'updatedAt', 'filename', 'mimetype', 'extname', 'url', 'storageId'],
      }),
    );
    expect(
      (screen.getByRole('listbox', { name: 'Choose documents' }) as HTMLSelectElement).selectedOptions,
    ).toHaveLength(0);
    expect(mocks.spaceApi.create).not.toHaveBeenCalled();
  });

  it('keeps scalar editing available and omits documents when Space attachment fields are not readable', async () => {
    mocks.spaceApi.list.mockResolvedValue({
      data: {
        data: [{ id: 5, title: 'Guide', llmService: 'openai', model: 'gpt-4', outputFormat: 'html' }],
      },
    });
    mocks.spaceApi.get.mockRejectedValue(new Error('Forbidden'));
    render(
      <App>
        <UserGuideManager />
      </App>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Documents are not editable for this role')).toBeInTheDocument();
    expect(mocks.attachmentApi.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(mocks.spaceApi.update).toHaveBeenCalled());
    expect(mocks.spaceApi.update.mock.calls[0]?.[0]?.values).not.toHaveProperty('documents');
  });

  it('locks document changes and save until the upload request settles', async () => {
    const uploaded = makeAttachment(44, 'Uploaded.pdf');
    mocks.attachmentApi.list.mockResolvedValue({ data: { data: [makeAttachment(55, 'Other.pdf')] } });
    let finishUpload: ((result: { data: { id: number } }) => void) | undefined;
    mocks.attachmentApi.get.mockResolvedValue({ data: { data: uploaded } });
    mocks.fileManager.uploadFile.mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    render(
      <App>
        <UserGuideManager />
      </App>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create space/ }));
    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(['guide'], 'Uploaded.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(mocks.fileManager.uploadFile).toHaveBeenCalled());

    const documentsField = screen.getByRole('listbox', { name: 'Choose documents' });
    const submitButton = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(documentsField).toBeDisabled());
    expect(submitButton).toBeDisabled();
    fireEvent.mouseDown(documentsField);
    fireEvent.change(documentsField, { target: { value: '55' } });
    fireEvent.click(submitButton);
    expect(mocks.spaceApi.create).not.toHaveBeenCalled();
    expect((documentsField as HTMLSelectElement).selectedOptions).toHaveLength(0);

    finishUpload?.({ data: { id: 44 } });
    await waitFor(() => expect(screen.getByText('Uploaded.pdf')).toBeInTheDocument());
    await waitFor(() => expect(documentsField).not.toBeDisabled());
    expect(Array.from((documentsField as HTMLSelectElement).selectedOptions).map((option) => option.value)).toEqual([
      '44',
    ]);
  });
});
