import type { ContextItem } from '@nocobase/plugin-ai/client-v2';

export const FILE_PREVIEW_WORK_CONTEXT_TYPE = 'file-preview';

export function createFilePreviewWorkContext(file: unknown): ContextItem {
  const source = file && typeof file === 'object' ? (file as Record<string, unknown>) : {};
  const storage =
    source.storage && typeof source.storage === 'object' ? (source.storage as Record<string, unknown>) : {};
  const title = String(
    source.title && source.extname
      ? `${source.title}${source.extname}`
      : source.filename || source.name || source.title || 'file',
  );
  const fields = [
    'id',
    'uid',
    'url',
    'preview',
    'title',
    'extname',
    'mimetype',
    'size',
    'path',
    'storage_id',
    'storage',
    'collectionName',
  ];
  const normalized = {
    ...Object.fromEntries(fields.map((key) => [key, source[key]])),
    filename: source.filename || source.name,
    name: source.name || source.filename,
    storageId: source.storageId ?? source.storage_id ?? storage.id,
    storageType: source.storageType || storage.type,
    storageName: source.storageName || storage.name,
  };
  return {
    type: FILE_PREVIEW_WORK_CONTEXT_TYPE,
    uid: `file-preview:${String(source.id ?? source.uid ?? source.url ?? source.path ?? title)}`,
    title,
    content: { source: 'plugin-file-preview-auth', file: normalized },
  };
}
