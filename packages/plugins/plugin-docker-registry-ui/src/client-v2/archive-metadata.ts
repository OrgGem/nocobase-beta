import { inspectArchiveMetadataDocuments, type RegistryArchiveMetadata } from '../shared/archive-metadata';
import type { RegistryArchiveFormat } from '../shared/types';

const TAR_BLOCK_SIZE = 512;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100000;

function tarString(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.slice(offset, offset + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes).trim();
}

function tarSize(header: Uint8Array): number {
  const value = tarString(header, 124, 12).replace(/\s/g, '');
  if (!/^[0-7]+$/.test(value)) throw new Error('Archive contains an unsupported TAR entry size');
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Archive contains an invalid TAR entry size');
  return size;
}

function tarPath(header: Uint8Array): string {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  return `${prefix ? `${prefix}/` : ''}${name}`.replace(/^\.\//, '');
}

function isEmptyBlock(header: Uint8Array): boolean {
  return header.every((value) => value === 0);
}

async function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const candidate = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (candidate.arrayBuffer) return candidate.arrayBuffer();
  return new Response(blob).arrayBuffer();
}

async function blobText(blob: Blob): Promise<string> {
  const candidate = blob as Blob & { text?: () => Promise<string> };
  if (candidate.text) return candidate.text();
  return new Response(blob).text();
}

async function readJson(file: File, offset: number, size: number, name: string): Promise<unknown> {
  if (size > MAX_METADATA_BYTES) throw new Error(`${name} is too large`);
  try {
    return JSON.parse(await blobText(file.slice(offset, offset + size))) as unknown;
  } catch {
    throw new Error(`Archive contains invalid ${name}`);
  }
}

export async function inspectImageArchiveFile(
  file: File,
  preferredFormat: RegistryArchiveFormat,
): Promise<RegistryArchiveMetadata> {
  let offset = 0;
  let entryCount = 0;
  let dockerManifest: unknown;
  let ociIndex: unknown;

  while (offset + TAR_BLOCK_SIZE <= file.size) {
    const header = new Uint8Array(await blobArrayBuffer(file.slice(offset, offset + TAR_BLOCK_SIZE)));
    if (isEmptyBlock(header)) break;
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Archive contains too many entries');
    const name = tarPath(header);
    const size = tarSize(header);
    const bodyOffset = offset + TAR_BLOCK_SIZE;
    if (name === 'manifest.json') dockerManifest = await readJson(file, bodyOffset, size, name);
    if (name === 'index.json') ociIndex = await readJson(file, bodyOffset, size, name);
    if (preferredFormat === 'docker' && dockerManifest !== undefined) break;
    if (preferredFormat === 'oci' && ociIndex !== undefined) break;
    offset = bodyOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  if (dockerManifest === undefined && ociIndex === undefined) {
    throw new Error('Archive does not contain manifest.json or index.json');
  }
  return inspectArchiveMetadataDocuments({ dockerManifest, ociIndex }, preferredFormat);
}
