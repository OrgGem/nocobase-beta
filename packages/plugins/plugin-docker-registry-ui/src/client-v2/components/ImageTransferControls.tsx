import React, { useEffect, useState } from 'react';
import { DownloadOutlined, InboxOutlined, UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  AutoComplete,
  Button,
  Dropdown,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Typography,
  Upload,
  type MenuProps,
  type UploadFile,
} from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import {
  archiveReferenceLabel,
  suggestArchiveDestination,
  type RegistryArchiveMetadata,
} from '../../shared/archive-metadata';
import type { RegistryArchiveFormat, RegistryTransferResult } from '../../shared/types';
import { registryApi } from '../api';
import { inspectImageArchiveFile } from '../archive-metadata';
import { useT } from '../locale';

interface UploadFormValues {
  repository: string;
  tag: string;
  format: RegistryArchiveFormat;
  files: UploadFile[];
}

interface UploadImageButtonProps {
  initialRepository?: string;
  maxTransferSizeMb?: number;
  onUploaded?: (result: RegistryTransferResult) => Promise<void> | void;
}

function normalizeFiles(event: { fileList?: UploadFile[] } | UploadFile[]): UploadFile[] {
  return Array.isArray(event) ? event : event.fileList ?? [];
}

function nonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

export function UploadImageButton({ initialRepository = '', maxTransferSizeMb, onUploaded }: UploadImageButtonProps) {
  const ctx = useFlowContext();
  const t = useT();
  const [form] = Form.useForm<UploadFormValues>();
  const watchedRepository = Form.useWatch('repository', form);
  const watchedTag = Form.useWatch('tag', form);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [archiveMetadata, setArchiveMetadata] = useState<RegistryArchiveMetadata>();
  const [archiveMetadataError, setArchiveMetadataError] = useState(false);
  const detectedDestination = archiveMetadata
    ? suggestArchiveDestination(archiveMetadata, { repository: watchedRepository, tag: watchedTag })
    : undefined;
  const detectedDestinationComplete = Boolean(
    detectedDestination?.repository &&
      detectedDestination.tag &&
      !detectedDestination.repositoryAmbiguous &&
      !detectedDestination.tagAmbiguous,
  );

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ repository: initialRepository, tag: '', format: 'docker', files: [] });
      setArchiveMetadata(undefined);
      setArchiveMetadataError(false);
    }
  }, [form, initialRepository, open]);

  const inspectArchiveSelection = async (files: UploadFile[], preferredFormat?: RegistryArchiveFormat) => {
    form.setFieldValue('files', files);
    setArchiveMetadata(undefined);
    setArchiveMetadataError(false);
    const file = files[0]?.originFileObj;
    if (!file) return;
    setInspecting(true);
    try {
      const selectedFormat = form.getFieldValue('format') as RegistryArchiveFormat | undefined;
      const format = preferredFormat ?? selectedFormat ?? 'docker';
      const metadata = await inspectImageArchiveFile(file, format);
      const current = form.getFieldsValue(['repository', 'tag']);
      const suggestion = suggestArchiveDestination(metadata, current);
      form.setFieldsValue({
        repository: suggestion.repository ?? current.repository ?? '',
        tag: suggestion.tag ?? current.tag ?? '',
        format: metadata.format,
      });
      setArchiveMetadata(metadata);
    } catch {
      setArchiveMetadataError(true);
    } finally {
      setInspecting(false);
    }
  };

  const handleFormatChange = async (format: RegistryArchiveFormat) => {
    const files = form.getFieldValue('files') as UploadFile[] | undefined;
    if (files?.[0]?.originFileObj) await inspectArchiveSelection(files, format);
  };

  const handleUpload = async () => {
    const values = await form.validateFields();
    const file = values.files[0]?.originFileObj;
    if (!file) return;
    if (maxTransferSizeMb && file.size > maxTransferSizeMb * 1024 * 1024) {
      ctx.message.error(t('The selected archive exceeds the configured transfer limit.'));
      return;
    }
    setUploading(true);
    try {
      const result = await registryApi.uploadImage(
        ctx,
        file,
        values.repository.trim(),
        values.tag.trim(),
        values.format,
      );
      ctx.message.success(
        t('Image uploaded successfully to {{repository}}:{{tag}}', {
          repository: result.repository,
          tag: result.tag,
        }),
      );
      setOpen(false);
      await onUploaded?.(result);
    } catch (error) {
      ctx.message.error(error instanceof Error ? error.message : t('Unable to upload image'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <Button icon={<UploadOutlined />} onClick={() => setOpen(true)}>
        {t('Upload image')}
      </Button>
      <Modal
        open={open}
        title={t('Upload image archive')}
        okText={t('Upload')}
        cancelText={t('Cancel')}
        confirmLoading={uploading}
        okButtonProps={{ disabled: uploading || inspecting }}
        cancelButtonProps={{ disabled: uploading || inspecting }}
        maskClosable={!uploading && !inspecting}
        closable={!uploading && !inspecting}
        onCancel={() => setOpen(false)}
        onOk={handleUpload}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item
            name="repository"
            label={t('Destination repository (optional)')}
            rules={[
              {
                pattern: /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i,
                message: t('Enter a valid repository name'),
              },
            ]}
          >
            <AutoComplete
              options={[
                ...new Set(archiveMetadata?.references.map((reference) => reference.repository).filter(nonEmptyString)),
              ].map((value) => ({ value }))}
              allowClear
              aria-label={t('Destination repository (optional)')}
            >
              <Input autoComplete="off" placeholder={t('team/image (auto-detected)')} />
            </AutoComplete>
          </Form.Item>
          <Form.Item
            name="tag"
            label={t('Destination tag (optional)')}
            rules={[{ pattern: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, message: t('Enter a valid tag') }]}
          >
            <AutoComplete
              options={[
                ...new Set(archiveMetadata?.references.map((reference) => reference.tag).filter(nonEmptyString)),
              ].map((value) => ({ value }))}
              allowClear
              aria-label={t('Destination tag (optional)')}
            >
              <Input autoComplete="off" placeholder={t('latest (auto-detected)')} />
            </AutoComplete>
          </Form.Item>
          <Form.Item name="format" label={t('Archive format')} rules={[{ required: true }]}>
            <Select
              onChange={handleFormatChange}
              options={[
                { value: 'docker', label: t('Docker save tar') },
                { value: 'oci', label: t('OCI image-layout tar') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="files"
            label={t('Archive file')}
            valuePropName="fileList"
            getValueFromEvent={normalizeFiles}
            rules={[{ required: true, message: t('Select a tar archive') }]}
          >
            <Upload.Dragger
              accept=".tar,application/x-tar"
              maxCount={1}
              beforeUpload={() => false}
              onChange={({ fileList }) => inspectArchiveSelection(fileList)}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">{t('Select or drop a .tar image archive')}</p>
              <Typography.Text type="secondary">
                {maxTransferSizeMb
                  ? t('Maximum upload size: {{size}} MB', { size: maxTransferSizeMb })
                  : t('The server validates archive size, paths and SHA-256 digests.')}
              </Typography.Text>
            </Upload.Dragger>
          </Form.Item>
          {inspecting && <Typography.Text type="secondary">{t('Reading archive metadata…')}</Typography.Text>}
          {archiveMetadataError && (
            <Alert
              type="warning"
              showIcon
              message={t('Archive metadata could not be read')}
              description={t('Enter the destination repository and tag manually.')}
            />
          )}
          {archiveMetadata && !inspecting && (
            <Alert
              type={detectedDestinationComplete ? 'success' : 'warning'}
              showIcon
              message={t('Detected {{format}} archive', { format: archiveMetadata.format.toUpperCase() })}
              description={
                archiveMetadata.references.length
                  ? t('Detected archive references: {{references}}', {
                      references: archiveMetadata.references.map(archiveReferenceLabel).join(', '),
                    })
                  : t('Archive has no unambiguous repository and tag; enter them manually.')
              }
            />
          )}
        </Form>
      </Modal>
    </>
  );
}

interface DownloadImageButtonProps {
  repository: string;
  reference: string;
}

export function DownloadImageButton({ repository, reference }: DownloadImageButtonProps) {
  const ctx = useFlowContext();
  const t = useT();
  const [format, setFormat] = useState<RegistryArchiveFormat>();

  const download = async (selectedFormat: RegistryArchiveFormat) => {
    setFormat(selectedFormat);
    try {
      await registryApi.downloadImage(ctx, repository, reference, selectedFormat);
      ctx.message.success(t('Image download completed'));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      ctx.message.error(error instanceof Error ? error.message : t('Unable to download image'));
    } finally {
      setFormat(undefined);
    }
  };

  const items: MenuProps['items'] = [
    { key: 'docker', label: t('Docker save tar') },
    { key: 'oci', label: t('OCI image-layout tar') },
  ];
  return (
    <Space.Compact>
      <Dropdown
        menu={{ items, onClick: ({ key }) => download(key as RegistryArchiveFormat) }}
        trigger={['click']}
        disabled={Boolean(format)}
      >
        <Button icon={<DownloadOutlined />} loading={Boolean(format)} aria-label={t('Download image')}>
          {format ? t('Downloading') : t('Download')}
        </Button>
      </Dropdown>
    </Space.Compact>
  );
}
