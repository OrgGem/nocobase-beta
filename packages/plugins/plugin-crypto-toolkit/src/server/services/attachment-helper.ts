import { Application } from '@nocobase/server';
import { unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CryptoToolkitHttpError } from '../http-error';

type FileManager = {
  storagesCache: Map<unknown, unknown>;
  getFileStream: (record: unknown) => Promise<{ stream: AsyncIterable<Buffer | Uint8Array> }>;
  createFileRecord: (input: {
    collectionName: string;
    storageName?: string;
    filePath: string;
    values: Record<string, unknown>;
  }) => Promise<unknown>;
};

export interface AttachmentReadOptions {
  ownerId: number;
  maxBytes?: number;
}

export interface AttachmentWriteOptions {
  filename: string;
  storageId?: number | string | null;
  title?: string;
  createdById: number;
}

function getFileManager(app: Application): FileManager {
  const fileManager = app.pm.get('file-manager') as FileManager | undefined;
  if (!fileManager) throw new Error('plugin-file-manager is not loaded');
  return fileManager;
}

/**
 * Read the raw bytes of a `plugin-file-manager` attachment record.
 * Streams directly from the configured storage adapter — bypasses any HTTP
 * auth layer that could 401 a plain axios call.
 */
export async function readAttachmentBuffer(
  app: Application,
  attachmentId: number | string,
  options: AttachmentReadOptions,
): Promise<{ buffer: Buffer; attachment: unknown; fileManager: FileManager }> {
  if (!attachmentId && attachmentId !== 0) throw new Error('attachmentId is required');

  const fileManager = getFileManager(app);
  const attachment = await app.db.getRepository('attachments').findOne({
    filter: { id: attachmentId },
  });
  if (!attachment) {
    throw new CryptoToolkitHttpError(404, 'CRYPTOTOOLKIT_NOT_FOUND', `attachment ${attachmentId} not found`);
  }

  // Ownership is checked in JS rather than in the query: attachments created
  // through paths without request context carry a null createdById, and a
  // `{ createdById: ownerId }` filter would reject them even though the same
  // user just uploaded them. Only reject when an owner is recorded and differs.
  const ownerRaw =
    (attachment as { get?: (k: string) => unknown }).get?.('createdById') ??
    (attachment as { createdById?: unknown }).createdById;
  if (ownerRaw != null && Number(ownerRaw) !== Number(options.ownerId)) {
    throw new CryptoToolkitHttpError(
      403,
      'CRYPTOTOOLKIT_FORBIDDEN',
      `attachment ${attachmentId} is not owned by the current user`,
    );
  }

  let matchedKey: unknown = null;
  const rawStorageId =
    (attachment as { get?: (k: string) => unknown }).get?.('storageId') ??
    (attachment as { storageId?: unknown }).storageId;
  if (rawStorageId) {
    const strId = String(rawStorageId);
    for (const key of fileManager.storagesCache.keys()) {
      if (String(key) === strId) {
        matchedKey = key;
        break;
      }
    }
  }

  const attachmentObj =
    typeof (attachment as { toJSON?: () => unknown }).toJSON === 'function'
      ? (attachment as { toJSON: () => Record<string, unknown> }).toJSON()
      : { ...(attachment as Record<string, unknown>) };
  if (matchedKey !== null) {
    (attachmentObj as { storageId?: unknown }).storageId = matchedKey;
  }

  const { stream } = await fileManager.getFileStream(attachmentObj);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.length;
    if (options.maxBytes !== undefined && size > options.maxBytes) {
      throw new CryptoToolkitHttpError(
        400,
        'CRYPTOTOOLKIT_PAYLOAD_TOO_LARGE',
        `attachment ${attachmentId} exceeds the maximum allowed size of ${options.maxBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return { buffer: Buffer.concat(chunks), attachment, fileManager };
}

/**
 * Lookup a storage record by id and return its `name` (which is what
 * `fileManager.createFileRecord({ storageName })` expects). Returns
 * undefined when the id is null/missing — callers should fall back to the
 * default storage in that case.
 */
export async function resolveStorageName(
  app: Application,
  storageId?: number | string | null,
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
  options: AttachmentWriteOptions,
): Promise<unknown> {
  const fileManager = getFileManager(app);

  const storageName = await resolveStorageName(app, options.storageId);

  const ext = (options.filename.match(/\.[^.]+$/) ?? [''])[0];
  const tempPath = join(tmpdir(), `crypto-${randomUUID()}${ext}`);
  await writeFile(tempPath, buffer);
  try {
    return await fileManager.createFileRecord({
      collectionName: 'attachments',
      storageName,
      filePath: tempPath,
      values: {
        title: options.title ?? options.filename,
        createdById: options.createdById,
      },
    });
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}
