import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Spin } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useCarboneTranslation } from '../locale';

interface Props {
  open: boolean;
  onClose: () => void;
  /** API url (e.g. `carboneTemplates:download/12`) — fetched as a blob with auth. */
  url: string;
  filename: string;
}

const PREVIEWABLE_INLINE = new Set(['.pdf', '.html', '.svg', '.txt', '.csv']);
const PREVIEWABLE_IMAGE = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Self-contained preview modal for the client-v2 lane. The v1 component relied
 * on `attachmentFileTypes` / `filePreviewTypes` registries that only exist in
 * the v1 client; here we fetch the file through the authenticated API client as
 * a blob and render it inline (PDF/HTML/img) or offer a download fallback.
 *
 * `url` may be either an `/api/...`-prefixed path or a bare resource action; we
 * normalise it to go through `apiClient.request` so the auth header is attached
 * (a plain <iframe src> would 401 against protected download actions).
 */
export const TemplatePreviewModal: React.FC<Props> = ({ open, onClose, url, filename }) => {
  const { t } = useCarboneTranslation();
  const app = useApp();
  const api = app.apiClient;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const extname = useMemo(() => (filename ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : ''), [filename]);

  useEffect(() => {
    if (!open || !url) return;
    // Callers pass either an already-rendered `blob:` URL or an `/api/...` path
    // that must be fetched through the authenticated client. Use blob URLs
    // as-is and only fetch real API paths.
    if (url.startsWith('blob:')) {
      setBlobUrl(url);
      setLoading(false);
      return;
    }
    let revoked: string | null = null;
    setLoading(true);
    const requestUrl = url.replace(/^\/api\//, '');
    api
      .request({ url: requestUrl, method: 'get', responseType: 'blob' })
      .then((res: any) => {
        const objUrl = URL.createObjectURL(res.data);
        revoked = objUrl;
        setBlobUrl(objUrl);
        setLoading(false);
      })
      .catch(() => {
        setBlobUrl(null);
        setLoading(false);
      });
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
      setBlobUrl(null);
    };
  }, [open, url, api]);

  const onDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      title={filename || t('Preview')}
      width="90%"
      footer={null}
      onCancel={onClose}
      destroyOnClose
      okButtonProps={{ style: { display: 'none' } }}
    >
      <Spin spinning={loading}>
        <div style={{ minHeight: '70vh' }}>
          {blobUrl && PREVIEWABLE_INLINE.has(extname) && (
            <iframe
              title="carbone-template-preview"
              src={blobUrl}
              style={{ width: '100%', height: '78vh', border: '1px solid #f0f0f0', borderRadius: 4 }}
            />
          )}
          {blobUrl && PREVIEWABLE_IMAGE.has(extname) && (
            <img
              alt="carbone-template-preview"
              src={blobUrl}
              style={{ maxWidth: '100%', maxHeight: '78vh', display: 'block', margin: '0 auto' }}
            />
          )}
          {blobUrl && !PREVIEWABLE_INLINE.has(extname) && !PREVIEWABLE_IMAGE.has(extname) && (
            <div
              style={{
                height: '70vh',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
                background: '#fafafa',
                border: '1px dashed #d9d9d9',
                borderRadius: 8,
              }}
            >
              <div style={{ fontSize: 16, color: '#595959' }}>
                {t('This format cannot be previewed inline. Please use the Download button to view the file.')}
              </div>
              <a onClick={onDownload} style={{ cursor: 'pointer' }}>
                {t('Download')} — {filename}
              </a>
            </div>
          )}
        </div>
      </Spin>
    </Modal>
  );
};

export default TemplatePreviewModal;
