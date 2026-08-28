import React, { useMemo } from 'react';
import { Modal } from 'antd';
// @ts-ignore
import { attachmentFileTypes } from '@nocobase/client';
// @ts-ignore
import { filePreviewTypes } from "@nocobase/plugin-file-manager";

interface Props {
  open: boolean;
  onClose: () => void;
  url: string;
  filename: string;
}

export const TemplatePreviewModal: React.FC<Props> = ({ open, onClose, url, filename }) => {
  const file: any = useMemo(() => {
    const extname = filename ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
    return {
      url,
      filename,
      title: filename,
      name: filename,
      extname,
      mimetype: mimeTypeFromExt(extname),
    };
  }, [url, filename]);

  if (!open) return null;

  const attachmentPreviewer = attachmentFileTypes?.getTypeByFile?.(file)?.Previewer;
  if (attachmentPreviewer) {
    const PreviewerComponent = attachmentPreviewer;
    return (
      <PreviewerComponent
        index={0}
        list={[file]}
        onSwitchIndex={(nextIndex: number | null) => {
          if (nextIndex == null || nextIndex !== 0) onClose();
        }}
      />
    );
  }

  const PreviewerComponent = filePreviewTypes?.getTypeByFile?.(file)?.Previewer;
  if (PreviewerComponent) {
    return (
      <PreviewerComponent
        open={open}
        onOpenChange={(nextOpen: boolean) => !nextOpen && onClose()}
        onClose={onClose}
        file={file}
        index={0}
        list={[file]}
        onSwitchIndex={(nextIndex: number | null) => {
          if (nextIndex == null || nextIndex !== 0) onClose();
        }}
        onDownload={() => downloadByUrl(url, filename)}
      />
    );
  }

  // Final fallback if no NocoBase previewers are available
  return (
    <Modal open={open} title={filename || 'Preview'} width="90%" footer={null} onCancel={onClose} destroyOnClose>
      <div
        style={{
          width: '100%',
          height: '80vh',
          padding: 40,
          textAlign: 'center',
          backgroundColor: '#fafafa',
          border: '1px dashed #d9d9d9',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ fontSize: 48, color: '#bfbfbf', marginBottom: 16 }}>📄</div>
        <div style={{ fontSize: 16, color: '#595959', marginBottom: 8 }}>Preview not supported</div>
        <div style={{ color: '#8c8c8c' }}>
          The file type <strong>{file.extname.toUpperCase()}</strong> cannot be previewed directly.
        </div>
      </div>
    </Modal>
  );
};

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.html': 'text/html',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function mimeTypeFromExt(extname: string): string {
  return MIME_BY_EXT[extname] || 'application/octet-stream';
}

function downloadByUrl(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

