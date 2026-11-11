/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Select, Space, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useTranslation } from 'react-i18next';

const namespace = 'build-guide-block';
type ID = string | number;
type DocumentRecord = { id: ID; filename: string; mimetype?: string; extname?: string };
type StorageRules = { size?: number; mimetype?: string | string[] };
type StorageCheck = {
  isSupportToUploadFiles: boolean;
  storage: { id: ID; type: string; rules?: StorageRules };
};
type FileManagerClient = {
  uploadFile(options: {
    file: File;
    fileCollectionName: string;
    storageId?: number;
    storageType?: string;
    storageRules?: StorageRules;
  }): Promise<{ data?: unknown; errorMessage?: string }>;
};

const DOCUMENT_FIELDS = ['id', 'updatedAt', 'filename', 'mimetype', 'extname', 'url', 'storageId'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isId(value: unknown): value is ID {
  return typeof value === 'string' || typeof value === 'number';
}

function readApiData(response: unknown): unknown {
  if (!isRecord(response)) return response;
  const envelope = response.data;
  if (!isRecord(envelope)) return envelope ?? response;
  return envelope.data ?? envelope;
}

function isDocumentRecord(value: unknown): value is DocumentRecord {
  return isRecord(value) && isId(value.id) && typeof value.filename === 'string';
}

function isReadableGuideDocument(value: unknown): value is DocumentRecord {
  return isDocumentRecord(value) && DOCUMENT_FIELDS.every((field) => field in value);
}

function isStorageCheck(value: unknown): value is StorageCheck {
  return (
    isRecord(value) &&
    value.isSupportToUploadFiles === true &&
    isRecord(value.storage) &&
    isId(value.storage.id) &&
    typeof value.storage.type === 'string'
  );
}

function isFileManagerClient(value: unknown): value is FileManagerClient {
  return isRecord(value) && typeof value.uploadFile === 'function';
}

function storageRules(value: unknown): StorageRules | undefined {
  if (!isRecord(value)) return undefined;
  const rules: StorageRules = {};
  if (typeof value.size === 'number') rules.size = value.size;
  if (typeof value.mimetype === 'string') {
    rules.mimetype = value.mimetype as string | string[];
  } else if (Array.isArray(value.mimetype) && value.mimetype.every((item) => typeof item === 'string')) {
    rules.mimetype = value.mimetype;
  }
  return rules;
}

export function GuideDocumentPicker({
  value,
  onChange,
  onMutationChange,
  disabled = false,
}: {
  value?: ID[];
  onChange?: (value: ID[]) => void;
  onMutationChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation([namespace, 'client']);
  const app = useApp();
  const api = app.apiClient;
  const { message } = App.useApp();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [listError, setListError] = useState(false);
  const requestSequence = useRef(0);
  const checkedDocumentIds = useRef(new Set<string>());
  const selectedIds = useMemo(() => (Array.isArray(value) ? value.filter(isId) : []), [value]);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const mergeDocuments = useCallback((records: DocumentRecord[]) => {
    if (!records.length) return;
    setDocuments((current) => {
      const next = new Map(current.map((document) => [String(document.id), document]));
      records.forEach((document) => next.set(String(document.id), document));
      return [...next.values()];
    });
  }, []);

  const getDocument = useCallback(
    async (id: ID) => {
      const response: unknown = await api.resource('attachments').get({
        filterByTk: id,
        fields: DOCUMENT_FIELDS,
      });
      const record = readApiData(response);
      return isReadableGuideDocument(record) ? record : null;
    },
    [api],
  );

  const loadDocuments = useCallback(
    async (search = '') => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      try {
        const response: unknown = await api.resource('attachments').list({
          fields: DOCUMENT_FIELDS,
          sort: ['-createdAt'],
          paginate: true,
          page: 1,
          pageSize: 50,
          ...(search ? { filter: { filename: { $includes: search } } } : {}),
        });
        const rows = readApiData(response);
        if (sequence !== requestSequence.current) return;
        mergeDocuments(Array.isArray(rows) ? rows.filter(isDocumentRecord) : []);
        setListError(false);
      } catch {
        if (sequence === requestSequence.current) setListError(true);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [api, mergeDocuments],
  );

  useEffect(() => {
    if (!disabled) loadDocuments();
  }, [disabled, loadDocuments]);

  useEffect(() => {
    if (!selectedIds.length) return undefined;
    let disposed = false;
    const unverified = selectedIds.filter((id) => !checkedDocumentIds.current.has(String(id)));
    if (!unverified.length) return undefined;
    unverified.forEach((id) => checkedDocumentIds.current.add(String(id)));
    Promise.all(
      unverified.map(async (id) => {
        try {
          return await getDocument(id);
        } catch {
          return null;
        }
      }),
    )
      .then((records) => {
        if (!disposed) mergeDocuments(records.filter((record): record is DocumentRecord => record !== null));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [selectedIds, getDocument, mergeDocuments]);

  const options = useMemo(() => {
    const byId = new Map(documents.map((document) => [String(document.id), document]));
    selectedIds.forEach((id) => {
      if (!byId.has(String(id))) {
        byId.set(String(id), { id, filename: t('Document unavailable ({{id}})', { id }) });
      }
    });
    return [...byId.values()].map((document) => ({ value: document.id, label: document.filename }));
  }, [documents, selectedIds, t]);

  const handleChange = async (nextIds: ID[]) => {
    if (disabled) return;
    const currentIds = Array.isArray(value) ? value.filter(isId) : [];
    const availableIds = new Set(documents.map((document) => String(document.id)));
    const addedIds = nextIds.filter((id) => !currentIds.some((current) => String(current) === String(id)));
    if (addedIds.some((id) => !availableIds.has(String(id)))) {
      message.error(t('Document cannot be used by this role'));
      return;
    }
    if (addedIds.length === 0) {
      onChange?.(nextIds);
      return;
    }

    setChecking(true);
    onMutationChange?.(true);
    addedIds.forEach((id) => checkedDocumentIds.current.add(String(id)));
    try {
      const checked = await Promise.all(
        addedIds.map(async (id) => {
          try {
            return await getDocument(id);
          } catch {
            return null;
          }
        }),
      );
      const allowed = checked.filter((record): record is DocumentRecord => record !== null);
      mergeDocuments(allowed);
      const retainedIds = currentIds.filter((id) => nextIds.some((nextId) => String(nextId) === String(id)));
      onChange?.([...retainedIds, ...allowed.map((document) => document.id)]);
      if (allowed.length !== addedIds.length) message.error(t('Document cannot be used by this role'));
    } finally {
      setChecking(false);
      onMutationChange?.(false);
    }
  };

  const uploadDocument = async (file: File) => {
    const fileManagerValue = app.pm.get('@nocobase/plugin-file-manager') || app.pm.get('file-manager');
    if (!isFileManagerClient(fileManagerValue)) throw new Error('File manager is unavailable');

    const checkResponse: unknown = await api.resource('storages').check({ fileCollectionName: 'attachments' });
    const check = readApiData(checkResponse);
    if (!isStorageCheck(check)) throw new Error('Storage is not available');
    const storageId = typeof check.storage.id === 'number' ? check.storage.id : undefined;
    const result = await fileManagerValue.uploadFile({
      file,
      fileCollectionName: 'attachments',
      storageId,
      storageType: check.storage.type,
      storageRules: storageRules(check.storage.rules),
    });
    if (result.errorMessage || !isRecord(result.data) || !isId(result.data.id)) {
      throw new Error('Upload failed');
    }
    const document = await getDocument(result.data.id);
    if (!document) throw new Error('Uploaded document cannot be read');
    return document;
  };

  const handleUpload: NonNullable<UploadProps['customRequest']> = (options) => {
    if (disabled) return;
    const file = options.file;
    if (!(file instanceof File)) {
      options.onError?.(new Error('Invalid file'));
      return;
    }
    if (selectedIds.length >= 10) {
      message.error(t('You can select up to 10 documents.'));
      options.onError?.(new Error('Document limit reached'));
      return;
    }
    setUploading(true);
    let cancelled = false;
    onMutationChange?.(true);
    uploadDocument(file)
      .then((document) => {
        if (cancelled) return;
        mergeDocuments([document]);
        const currentIds = selectedIdsRef.current;
        if (!currentIds.some((id) => String(id) === String(document.id))) onChange?.([...currentIds, document.id]);
        options.onProgress?.({ percent: 100 });
        options.onSuccess?.({ data: document });
      })
      .catch(() => {
        if (cancelled) return;
        message.error(t('Upload failed'));
        options.onError?.(new Error(t('Upload failed')));
      })
      .finally(() => {
        setUploading(false);
        onMutationChange?.(false);
      })
      .catch(() => undefined);
    return {
      abort: () => {
        cancelled = true;
        setUploading(false);
        onMutationChange?.(false);
      },
    };
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Select
        mode="multiple"
        value={selectedIds}
        options={options}
        maxCount={10}
        showSearch
        filterOption={false}
        loading={loading || checking}
        disabled={disabled || checking || uploading}
        aria-label={t('Choose documents')}
        onSearch={(search) => loadDocuments(search)}
        onChange={(ids: ID[]) => handleChange(ids)}
        onFocus={() => loadDocuments()}
        placeholder={t('Choose documents')}
      />
      <Upload
        accept="*"
        multiple={false}
        showUploadList={false}
        disabled={disabled || checking || uploading || selectedIds.length >= 10}
        customRequest={handleUpload}
      >
        <Button
          icon={<UploadOutlined />}
          loading={uploading}
          disabled={disabled || checking || selectedIds.length >= 10}
          aria-label={t('Upload documents')}
        >
          {t('Upload documents')}
        </Button>
      </Upload>
      {disabled && <Typography.Text type="secondary">{t('Documents are not editable for this role')}</Typography.Text>}
      {listError && <Typography.Text type="secondary">{t('Could not load documents')}</Typography.Text>}
    </Space>
  );
}
