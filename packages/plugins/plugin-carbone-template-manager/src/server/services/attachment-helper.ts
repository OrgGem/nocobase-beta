import { Application } from '@nocobase/server';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Read the raw bytes of a `plugin-file-manager` attachment record.
 * Streams directly from the configured storage adapter — bypasses any HTTP
 * auth layer that could 401 a plain axios call.
 */
export async function readAttachmentBuffer(
  app: Application,
  attachmentId: number | string,
): Promise<{
  buffer: Buffer;
  attachment: any;
  fileManager: any;
}> {
  if (!attachmentId) throw new Error('attachmentId is required');

  const fileManager = app.pm.get('file-manager') as any;
  if (!fileManager) throw new Error('plugin-file-manager is not loaded');

  const attachment = await app.db.getRepository('attachments').findOne({ filterByTk: attachmentId });
  if (!attachment) throw new Error(`attachment ${attachmentId} not found`);

  let matchedKey = null;
  const rawStorageId = attachment.get('storageId') || attachment.storageId;
  if (rawStorageId) {
    const strId = String(rawStorageId);
    for (const key of fileManager.storagesCache.keys()) {
      if (String(key) === strId) {
        matchedKey = key;
        break;
      }
    }
  }

  const attachmentObj = typeof attachment.toJSON === 'function' ? attachment.toJSON() : { ...attachment };
  if (matchedKey !== null) {
    attachmentObj.storageId = matchedKey;
  }

  const { stream } = await fileManager.getFileStream(attachmentObj);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return { buffer: Buffer.concat(chunks as any[]), attachment, fileManager };
}

/**
 * Lookup a storage record by id and return its `name` (which is what
 * `fileManager.createFileRecord({ storageName })` expects). Returns
 * undefined when the id is null/missing — callers should fall back to the
 * default storage in that case.
 */
export async function resolveStorageName(
  app: Application,
  storageId?: number | null,
): Promise<string | undefined> {
  if (!storageId) return undefined;
  const storage = await app.db.getRepository('storages').findOne({ filterByTk: storageId });
  return storage?.name as string | undefined;
}

/**
 * Write a buffer to a temp file then call `fileManager.createFileRecord` so
 * the output ends up in whichever storage the user selected. The temp file
 * is cleaned up regardless of success/failure.
 */
export async function writeBufferAsAttachment(
  app: Application,
  buffer: Buffer,
  options: {
    filename: string;
    storageId?: number | null;
  },
): Promise<any> {
  const fileManager = app.pm.get('file-manager') as any;
  if (!fileManager) throw new Error('plugin-file-manager is not loaded');

  const storageName = await resolveStorageName(app, options.storageId);

  const ext = (options.filename.match(/\.[^.]+$/) ?? [''])[0];
  const tempPath = join(tmpdir(), `carbone-${randomUUID()}${ext}`);
  await writeFile(tempPath, buffer);
  try {
    return await fileManager.createFileRecord({
      collectionName: 'attachments',
      storageName,
      filePath: tempPath,
      values: { title: options.filename },
    });
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}
