import React, { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal, Select, Space, Spin, Upload, message } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useCarboneTranslation } from '../locale';
import { COLLECTION, SUPPORTED_OUTPUT_FORMATS } from '../../shared/constants';
import { PlaceholderTree, PlaceholderSchemaView } from './PlaceholderTree';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Existing template. If provided we upload a new version and prefill the
   * current version metadata so the next version gets its own snapshot.
   */
  template?: {
    id: number;
    name: string;
    description?: string;
    category?: string;
    defaultOutputFormat?: string;
  } | null;
}

interface ParsedPreview {
  schema: PlaceholderSchemaView;
  fileMd5: string;
  fileSize: number;
}

/**
 * Two-step upload flow:
 *   1. Drop a file → POST /api/attachments:create (uses settings.backupStorageName
 *      so the original is mirrored on the chosen storage).
 *   2. POST /api/carboneTemplates:parsePlaceholders { attachmentId } to preview
 *      the placeholder schema before saving.
 *   3. User fills metadata → POST /api/carboneTemplates:upload to persist.
 */
export const TemplateUploadModal: React.FC<Props> = ({ open, onClose, onSaved, template }) => {
  const api = useApp().apiClient;
  const { t } = useCarboneTranslation();
  const [form] = Form.useForm();

  const [attachmentId, setAttachmentId] = useState<number | null>(null);
  const [attachmentMeta, setAttachmentMeta] = useState<{ filename: string } | null>(null);
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backupStorageName, setBackupStorageName] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setAttachmentId(null);
    setAttachmentMeta(null);
    setPreview(null);
    form.resetFields();
    if (template) {
      form.setFieldsValue({
        name: template.name,
        description: template.description,
        category: template.category,
        defaultOutputFormat: template.defaultOutputFormat,
      });
    }
    // Resolve the storage name corresponding to the configured backupStorageId.
    api
      .resource(COLLECTION.settings)
      .get()
      .then(async (r: any) => {
        const id = r?.data?.data?.backupStorageId;
        if (!id) return;
        const s = await api.resource('storages').get({ filterByTk: id });
        setBackupStorageName(s?.data?.data?.name);
      })
      .catch(() => undefined);
  }, [open, template, api, form]);

  const onFile = async (file: File) => {
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res: any = await api.request({
        url: `attachments:create${backupStorageName ? `?storage=${encodeURIComponent(backupStorageName)}` : ''}`,
        method: 'post',
        data: fd,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const attachment = res?.data?.data;
      if (!attachment?.id) throw new Error('attachment upload failed');
      setAttachmentId(attachment.id);
      setAttachmentMeta({ filename: attachment.filename || file.name });

      const parsed: any = await api
        .resource(COLLECTION.templates)
        .parsePlaceholders({ values: { attachmentId: attachment.id } });
      setPreview(parsed?.data);
    } catch (err: any) {
      message.error(err?.message || t('Upload failed'));
    } finally {
      setParsing(false);
    }
    return false; // antd Upload: prevent default submit
  };

  const onSave = async () => {
    if (!attachmentId) {
      message.warning(t('Please upload a file first'));
      return;
    }
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setSaving(true);
    try {
      await api.resource(COLLECTION.templates).upload({
        values: {
          ...v,
          attachmentId,
          ...(template ? { templateId: template.id } : {}),
        },
      });
      message.success(template ? t('New version saved') : t('Template created'));
      onSaved();
      onClose();
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || err?.message || t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onSave}
      okButtonProps={{ loading: saving, disabled: !attachmentId }}
      width={780}
      title={template ? t('Upload new version of "{{name}}"', { name: template.name }) : t('New template')}
      destroyOnClose
    >
      <Spin spinning={parsing}>
        <Upload.Dragger
          beforeUpload={onFile}
          showUploadList={false}
          maxCount={1}
          accept=".docx,.xlsx,.pptx,.odt,.ods,.odp,.doc,.xls,.ppt"
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{t('Drop a template file here or click to browse')}</p>
          <p className="ant-upload-hint">.docx · .xlsx · .pptx · .odt · .ods · .odp</p>
          {attachmentMeta && (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: 12 }}
              message={`${t('Uploaded')}: ${attachmentMeta.filename}`}
            />
          )}
        </Upload.Dragger>

        {preview && (
          <div style={{ marginTop: 16 }}>
            <h4>{t('Detected placeholders')}</h4>
            <PlaceholderTree schema={preview.schema} />
            <div style={{ color: '#888', marginTop: 4, fontSize: 12 }}>
              {t('MD5')}: <code>{preview.fileMd5}</code> · {t('Size')}: {(preview.fileSize / 1024).toFixed(1)} KB
            </div>
          </div>
        )}

        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('Name')} name="name" rules={[{ required: !template }]}>
            <Input disabled={!!template} maxLength={120} />
          </Form.Item>
          <Form.Item label={t('Description')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item label={t('Category')} name="category">
              <Input style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label={t('Default output format')} name="defaultOutputFormat" initialValue="pdf">
              <Select
                style={{ width: 140 }}
                options={SUPPORTED_OUTPUT_FORMATS.map((f) => ({ label: f.toUpperCase(), value: f }))}
              />
            </Form.Item>
          </Space>
          <Form.Item label={t('Change note')} name="changeNote">
            <Input.TextArea rows={2} placeholder={template ? t('Why did you upload this version?') : ''} />
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
};
