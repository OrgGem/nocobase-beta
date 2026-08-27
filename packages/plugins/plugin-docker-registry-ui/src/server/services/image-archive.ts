import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract, pack, type Headers } from 'tar-stream';
import { OCI_IMAGE_INDEX } from '../../shared/media-types';
import {
  archiveReferenceLabel,
  inspectArchiveMetadataDocuments,
  isValidRepository,
  isValidTag,
  NCOBASE_REPOSITORY_ANNOTATION,
  OCI_REFERENCE_NAME_ANNOTATION,
  suggestArchiveDestination,
  type RegistryArchiveMetadata,
} from '../../shared/archive-metadata';
import type { Descriptor, RegistryArchiveFormat, RegistryTransferResult } from '../../shared/types';
import { RegistryClient, RegistryRequestError } from './registry-client';

const OCI_IMAGE_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_IMAGE_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar';
const OCI_LAYER_GZIP = 'application/vnd.oci.image.layer.v1.tar+gzip';
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100000;

interface ManifestDocument {
  schemaVersion?: number;
  mediaType?: string;
  config?: Descriptor;
  layers?: Descriptor[];
  manifests?: Descriptor[];
}

interface GraphEntry extends Descriptor {
  body?: Buffer;
  manifest?: ManifestDocument;
}

interface ImageGraph {
  root: GraphEntry;
  entries: Map<string, GraphEntry>;
  totalBytes: number;
}

interface ExtractedEntry {
  archivePath: string;
  filePath: string;
  size: number;
  digest: string;
}

interface ExtractedArchive {
  directory: string;
  entries: Map<string, ExtractedEntry>;
  totalBytes: number;
}

interface DockerSaveManifestEntry {
  Config?: string;
  RepoTags?: string[];
  Layers?: string[];
}

type ArchiveRegistryClient = Pick<RegistryClient, 'getManifestDocument' | 'openBlob' | 'uploadBlob' | 'putManifest'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(body: Buffer): ManifestDocument {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new RegistryRequestError('Image archive contains invalid manifest JSON', 422, 'INVALID_ARCHIVE_MANIFEST');
  }
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new RegistryRequestError('Image archive manifest must use schemaVersion 2', 422, 'INVALID_ARCHIVE_MANIFEST');
  }
  return value as unknown as ManifestDocument;
}

function sha256(body: Buffer): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function digestPath(digest: string): string {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest);
  if (!match) throw new RegistryRequestError(`Unsupported digest ${digest}`, 422, 'UNSUPPORTED_DIGEST');
  return `blobs/sha256/${match[1].toLowerCase()}`;
}

function safeArchiveName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RegistryRequestError(`Unsafe archive path ${value}`, 422, 'UNSAFE_ARCHIVE_PATH');
  }
  return normalized;
}

function descriptorList(value: Descriptor[] | undefined): Descriptor[] {
  return Array.isArray(value) ? value.filter((item) => typeof item?.digest === 'string') : [];
}

function graphChildren(manifest: ManifestDocument): Descriptor[] {
  if (Array.isArray(manifest.manifests)) return descriptorList(manifest.manifests);
  return [...(manifest.config ? [manifest.config] : []), ...descriptorList(manifest.layers)];
}

async function collectImageGraph(
  client: ArchiveRegistryClient,
  repository: string,
  reference: string,
  maxBytes: number,
  abortSignal?: AbortSignal,
): Promise<ImageGraph> {
  const entries = new Map<string, GraphEntry>();
  let totalBytes = 0;

  const collectManifest = async (candidate: Descriptor | undefined, manifestReference: string): Promise<GraphEntry> => {
    // Check abort signal before each manifest fetch
    if (abortSignal?.aborted) {
      throw new RegistryRequestError('Download aborted', 499, 'TRANSFER_ABORTED');
    }
    
    const document = await client.getManifestDocument(repository, manifestReference);
    const digest = document.digest.startsWith('sha256:') ? document.digest : sha256(document.body);
    if (candidate?.digest && candidate.digest !== digest && candidate.digest !== sha256(document.body)) {
      throw new RegistryRequestError(
        `Manifest digest mismatch for ${candidate.digest}`,
        502,
        'MANIFEST_DIGEST_MISMATCH',
      );
    }
    const existing = entries.get(digest);
    if (existing) return existing;
    const manifest = parseManifest(document.body);
    const entry: GraphEntry = {
      digest,
      size: document.body.length,
      mediaType: manifest.mediaType || candidate?.mediaType || document.mediaType,
      body: document.body,
      manifest,
      platform: candidate?.platform,
      annotations: candidate?.annotations,
    };
    entries.set(digest, entry);
    totalBytes += document.body.length;
    for (const child of graphChildren(manifest)) {
      if (Array.isArray(manifest.manifests)) {
        await collectManifest(child, child.digest);
      } else if (!entries.has(child.digest)) {
        entries.set(child.digest, child);
        totalBytes += child.size ?? 0;
      }
      if (totalBytes > maxBytes) {
        throw new RegistryRequestError('Image exceeds the configured transfer size limit', 413, 'TRANSFER_TOO_LARGE');
      }
    }
    return entry;
  };

  const root = await collectManifest(undefined, reference);
  return { root, entries, totalBytes };
}

function tarEntry(archive: ReturnType<typeof pack>, header: Headers, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    archive.entry(header, body, (error) => (error ? reject(error) : resolve()));
  });
}

async function streamTarEntry(
  archive: ReturnType<typeof pack>,
  header: Headers,
  source: Readable,
  expectedSize: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  let transferred = 0;
  
  // Check abort signal before streaming
  if (abortSignal?.aborted) {
    throw new RegistryRequestError('Download aborted', 499, 'TRANSFER_ABORTED');
  }
  
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      
      // Check abort signal during streaming
      if (abortSignal?.aborted) {
        callback(new RegistryRequestError('Download aborted', 499, 'TRANSFER_ABORTED'));
        return;
      }
      
      callback(null, chunk);
    },
  });
  const entry = archive.entry(header);
  await pipeline(source, counter, entry);
  if (transferred !== expectedSize) {
    throw new RegistryRequestError(`Blob size mismatch for ${header.name}`, 502, 'BLOB_SIZE_MISMATCH');
  }
}

export function dockerArchiveRepoTag(publicRegistryHost: string, repository: string, reference: string): string {
  const prefix = publicRegistryHost ? `${publicRegistryHost.replace(/\/$/, '')}/` : '';
  return `${prefix}${repository}:${reference}`;
}

function preferredImage(graph: ImageGraph): GraphEntry | undefined {
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  const images = [...graph.entries.values()].filter((entry) => entry.manifest?.config && entry.manifest.layers);
  return (
    images.find((entry) => entry.platform?.os === process.platform && entry.platform?.architecture === architecture) ??
    images[0]
  );
}

export async function createImageArchiveStream(options: {
  client: ArchiveRegistryClient;
  repository: string;
  reference: string;
  format: RegistryArchiveFormat;
  publicRegistryHost: string;
  maxBytes: number;
  abortSignal?: AbortSignal;
}): Promise<{ stream: PassThrough; filename: string; totalBytes: number }> {
  const graph = await collectImageGraph(
    options.client, 
    options.repository, 
    options.reference, 
    options.maxBytes,
    options.abortSignal,
  );
  const output = new PassThrough();
  const archive = pack();
  archive.pipe(output);
  archive.once('error', (error) => output.destroy(error));

  // Listen for abort signal to destroy the output stream
  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', () => {
      output.destroy(new RegistryRequestError('Download aborted', 499, 'TRANSFER_ABORTED'));
    }, { once: true });
  }

  const write = async () => {
    const rootIndex = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_IMAGE_INDEX,
        manifests: [
          {
            mediaType: graph.root.mediaType,
            digest: graph.root.digest,
            size: graph.root.size,
            annotations: {
              [OCI_REFERENCE_NAME_ANNOTATION]: options.reference,
              [NCOBASE_REPOSITORY_ANNOTATION]: options.repository,
            },
          },
        ],
      }),
    );
    const layout = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    await tarEntry(archive, { name: 'oci-layout', size: layout.length, mode: 0o644 }, layout);
    await tarEntry(archive, { name: 'index.json', size: rootIndex.length, mode: 0o644 }, rootIndex);

    if (options.format === 'docker') {
      const image = preferredImage(graph);
      if (!image?.manifest?.config || !image.manifest.layers) {
        throw new RegistryRequestError(
          'Docker save export requires at least one image manifest',
          422,
          'DOCKER_EXPORT_UNSUPPORTED',
        );
      }
      const dockerManifest = Buffer.from(
        JSON.stringify([
          {
            Config: digestPath(image.manifest.config.digest),
            RepoTags: [dockerArchiveRepoTag(options.publicRegistryHost, options.repository, options.reference)],
            Layers: image.manifest.layers.map((layer) => digestPath(layer.digest)),
          },
        ]),
      );
      await tarEntry(archive, { name: 'manifest.json', size: dockerManifest.length, mode: 0o644 }, dockerManifest);
    }

    for (const entry of graph.entries.values()) {
      // Check abort signal before each blob download
      if (options.abortSignal?.aborted) {
        throw new RegistryRequestError('Download aborted', 499, 'TRANSFER_ABORTED');
      }
      
      const name = digestPath(entry.digest);
      if (entry.body) {
        await tarEntry(archive, { name, size: entry.body.length, mode: 0o644 }, entry.body);
      } else {
        const size = entry.size ?? 0;
        const blob = await options.client.openBlob(options.repository, entry.digest);
        await streamTarEntry(archive, { name, size, mode: 0o644 }, blob.stream, size, options.abortSignal);
      }
    }
    archive.finalize();
  };
  write().catch((error: unknown) => archive.destroy(error instanceof Error ? error : new Error(String(error))));

  const safeRepository = options.repository.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const safeReference = options.reference.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return {
    stream: output,
    filename: `${safeRepository}-${safeReference}.${options.format}.tar`,
    totalBytes: graph.totalBytes,
  };
}

async function extractImageArchive(input: Readable, maxBytes: number, timeoutMs: number): Promise<ExtractedArchive> {
  const directory = await mkdtemp(join(tmpdir(), 'nocobase-registry-upload-'));
  const entries = new Map<string, ExtractedEntry>();
  const parser = extract();
  let entryCount = 0;
  let totalBytes = 0;
  let failed: Error | undefined;

  parser.on('entry', (header, stream, next) => {
    const processEntry = async () => {
      if (header.type === 'directory') {
        const ended = onceStreamEnd(stream);
        stream.resume();
        await ended;
        return;
      }
      if (header.type !== 'file') {
        throw new RegistryRequestError(`Archive entry type ${header.type} is not allowed`, 422, 'UNSAFE_ARCHIVE_ENTRY');
      }
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new RegistryRequestError('Archive contains too many entries', 413, 'TOO_MANY_ARCHIVE_ENTRIES');
      }
      const archivePath = safeArchiveName(header.name);
      if (entries.has(archivePath)) {
        throw new RegistryRequestError(`Duplicate archive entry ${archivePath}`, 422, 'DUPLICATE_ARCHIVE_ENTRY');
      }
      const filePath = join(directory, `${entryCount}.entry`);
      const hash = createHash('sha256');
      let size = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            callback(
              new RegistryRequestError('Upload exceeds the configured transfer size limit', 413, 'TRANSFER_TOO_LARGE'),
            );
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(stream, limiter, createWriteStream(filePath, { flags: 'wx' }));
      entries.set(archivePath, {
        archivePath,
        filePath,
        size,
        digest: `sha256:${hash.digest('hex')}`,
      });
    };
    const continueExtraction = () => next();
    processEntry()
      .then(continueExtraction)
      .catch((error: unknown) => {
        failed = error instanceof Error ? error : new Error(String(error));
        parser.destroy(failed);
      });
  });

  const timer = setTimeout(
    () => parser.destroy(new RegistryRequestError('Upload timed out', 408, 'TRANSFER_TIMEOUT')),
    timeoutMs,
  );
  try {
    await pipeline(input, parser);
    if (failed) throw failed;
    return { directory, entries, totalBytes };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function onceStreamEnd(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
}

async function readJsonEntry(archive: ExtractedArchive, name: string): Promise<unknown> {
  const entry = archive.entries.get(name);
  if (!entry) throw new RegistryRequestError(`Archive is missing ${name}`, 422, 'ARCHIVE_FILE_MISSING');
  if (entry.size > MAX_JSON_BYTES)
    throw new RegistryRequestError(`${name} is too large`, 413, 'ARCHIVE_JSON_TOO_LARGE');
  try {
    return JSON.parse((await readFile(entry.filePath)).toString('utf8'));
  } catch {
    throw new RegistryRequestError(`Archive contains invalid ${name}`, 422, 'INVALID_ARCHIVE_JSON');
  }
}

async function readArchiveMetadata(
  archive: ExtractedArchive,
  preferredFormat: RegistryArchiveFormat,
): Promise<RegistryArchiveMetadata> {
  const dockerManifest = archive.entries.has('manifest.json')
    ? await readJsonEntry(archive, 'manifest.json')
    : undefined;
  const ociIndex = archive.entries.has('index.json') ? await readJsonEntry(archive, 'index.json') : undefined;
  return inspectArchiveMetadataDocuments({ dockerManifest, ociIndex }, preferredFormat);
}

function resolveArchiveDestination(
  metadata: RegistryArchiveMetadata,
  input: { repository?: string; tag?: string },
): { repository: string; tag: string } {
  const suggestion = suggestArchiveDestination(metadata, input);
  const references = metadata.references.map(archiveReferenceLabel).filter(Boolean).join(', ');
  if (suggestion.repositoryAmbiguous) {
    throw new RegistryRequestError(
      `Archive contains multiple repository references${references ? `: ${references}` : ''}`,
      422,
      'ARCHIVE_REPOSITORY_AMBIGUOUS',
    );
  }
  if (suggestion.tagAmbiguous) {
    throw new RegistryRequestError(
      `Archive contains multiple tag references${references ? `: ${references}` : ''}`,
      422,
      'ARCHIVE_TAG_AMBIGUOUS',
    );
  }
  if (!suggestion.repository) {
    throw new RegistryRequestError(
      'Archive does not contain a destination repository; enter one before uploading',
      422,
      'ARCHIVE_REPOSITORY_REQUIRED',
    );
  }
  if (!suggestion.tag) {
    throw new RegistryRequestError(
      'Archive does not contain a destination tag; enter one before uploading',
      422,
      'ARCHIVE_TAG_REQUIRED',
    );
  }
  if (!isValidRepository(suggestion.repository)) {
    throw new RegistryRequestError('A valid repository name is required', 400, 'INVALID_REPOSITORY');
  }
  if (!isValidTag(suggestion.tag)) {
    throw new RegistryRequestError('A valid tag is required', 400, 'INVALID_TAG');
  }
  return { repository: suggestion.repository, tag: suggestion.tag };
}

function descriptorEntry(archive: ExtractedArchive, descriptor: Descriptor): ExtractedEntry {
  const entry = archive.entries.get(digestPath(descriptor.digest));
  if (!entry) throw new RegistryRequestError(`Archive is missing ${descriptor.digest}`, 422, 'ARCHIVE_BLOB_MISSING');
  if (entry.digest !== descriptor.digest || (descriptor.size != null && descriptor.size !== entry.size)) {
    throw new RegistryRequestError(`Digest or size mismatch for ${descriptor.digest}`, 422, 'ARCHIVE_BLOB_MISMATCH');
  }
  return entry;
}

async function uploadOneBlob(
  client: ArchiveRegistryClient,
  repository: string,
  descriptor: Descriptor,
  entry: ExtractedEntry,
  chunkSize: number,
  counters: { uploadedBlobs: number; reusedBlobs: number; uploadedBytes: number },
) {
  const result = await client.uploadBlob(repository, descriptor.digest, entry.filePath, entry.size, chunkSize);
  if (result === 'uploaded') {
    counters.uploadedBlobs += 1;
    counters.uploadedBytes += entry.size;
  } else {
    counters.reusedBlobs += 1;
  }
}

async function uploadOciArchive(options: {
  archive: ExtractedArchive;
  client: ArchiveRegistryClient;
  repository: string;
  tag: string;
  format: RegistryArchiveFormat;
  chunkSize: number;
}): Promise<RegistryTransferResult> {
  const indexValue = await readJsonEntry(options.archive, 'index.json');
  if (!isRecord(indexValue) || !Array.isArray(indexValue.manifests) || !indexValue.manifests.length) {
    throw new RegistryRequestError('OCI index.json must contain at least one manifest', 422, 'INVALID_OCI_INDEX');
  }
  if (indexValue.manifests.length > 1) {
    throw new RegistryRequestError(
      'OCI archive contains multiple root images; upload one image archive at a time',
      422,
      'OCI_ARCHIVE_MULTIPLE_IMAGES',
    );
  }
  const root = (indexValue.manifests as Descriptor[])[0];
  const counters = { uploadedBlobs: 0, reusedBlobs: 0, uploadedBytes: 0 };
  const pushed = new Set<string>();
  const uploaded = new Set<string>();

  const pushManifest = async (descriptor: Descriptor, targetReference: string): Promise<string> => {
    const entry = descriptorEntry(options.archive, descriptor);
    const body = await readFile(entry.filePath);
    const manifest = parseManifest(body);
    for (const child of graphChildren(manifest)) {
      const childEntry = descriptorEntry(options.archive, child);
      if (Array.isArray(manifest.manifests)) {
        if (!pushed.has(child.digest)) {
          await pushManifest(child, child.digest);
          pushed.add(child.digest);
        }
      } else {
        if (!uploaded.has(child.digest)) {
          await uploadOneBlob(options.client, options.repository, child, childEntry, options.chunkSize, counters);
          uploaded.add(child.digest);
        }
      }
    }
    return options.client.putManifest(
      options.repository,
      targetReference,
      body,
      manifest.mediaType || descriptor.mediaType || OCI_IMAGE_MANIFEST,
    );
  };

  const digest = await pushManifest(root, options.tag);
  return {
    repository: options.repository,
    tag: options.tag,
    format: options.format,
    digest,
    ...counters,
  };
}

async function uploadLegacyDockerArchive(options: {
  archive: ExtractedArchive;
  client: ArchiveRegistryClient;
  repository: string;
  tag: string;
  chunkSize: number;
}): Promise<RegistryTransferResult> {
  const manifestValue = await readJsonEntry(options.archive, 'manifest.json');
  if (!Array.isArray(manifestValue) || !manifestValue.length || !isRecord(manifestValue[0])) {
    throw new RegistryRequestError(
      'Docker manifest.json must contain at least one image',
      422,
      'INVALID_DOCKER_ARCHIVE',
    );
  }
  if (manifestValue.length > 1) {
    throw new RegistryRequestError(
      'Docker archive contains multiple images; upload one image archive at a time',
      422,
      'DOCKER_ARCHIVE_MULTIPLE_IMAGES',
    );
  }
  const item = manifestValue[0] as DockerSaveManifestEntry;
  if (!item.Config || !Array.isArray(item.Layers) || !item.Layers.length) {
    throw new RegistryRequestError('Docker archive is missing config or layers', 422, 'INVALID_DOCKER_ARCHIVE');
  }
  const config = options.archive.entries.get(safeArchiveName(item.Config));
  if (!config) throw new RegistryRequestError(`Archive is missing ${item.Config}`, 422, 'ARCHIVE_BLOB_MISSING');
  const layers = item.Layers.map((name) => {
    const entry = options.archive.entries.get(safeArchiveName(name));
    if (!entry) throw new RegistryRequestError(`Archive is missing ${name}`, 422, 'ARCHIVE_BLOB_MISSING');
    return entry;
  });
  const configDescriptor: Descriptor = { digest: config.digest, size: config.size, mediaType: OCI_IMAGE_CONFIG };
  const layerDescriptors: Descriptor[] = [];
  for (const layer of layers) {
    const handle = await open(layer.filePath, 'r');
    const signature = Buffer.alloc(2);
    try {
      await handle.read(signature, 0, 2, 0);
    } finally {
      await handle.close();
    }
    const gzip = signature[0] === 0x1f && signature[1] === 0x8b;
    layerDescriptors.push({ digest: layer.digest, size: layer.size, mediaType: gzip ? OCI_LAYER_GZIP : OCI_LAYER });
  }
  const counters = { uploadedBlobs: 0, reusedBlobs: 0, uploadedBytes: 0 };
  await uploadOneBlob(options.client, options.repository, configDescriptor, config, options.chunkSize, counters);
  for (let index = 0; index < layers.length; index += 1) {
    await uploadOneBlob(
      options.client,
      options.repository,
      layerDescriptors[index],
      layers[index],
      options.chunkSize,
      counters,
    );
  }
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST,
      config: configDescriptor,
      layers: layerDescriptors,
    }),
  );
  const digest = await options.client.putManifest(options.repository, options.tag, body, OCI_IMAGE_MANIFEST);
  return { repository: options.repository, tag: options.tag, format: 'docker', digest, ...counters };
}

export async function uploadImageArchive(options: {
  input: Readable;
  client: ArchiveRegistryClient;
  repository?: string;
  tag?: string;
  format: RegistryArchiveFormat;
  maxBytes: number;
  chunkSize: number;
  timeoutMs: number;
}): Promise<RegistryTransferResult> {
  const archive = await extractImageArchive(options.input, options.maxBytes, options.timeoutMs);
  try {
    const metadata = await readArchiveMetadata(archive, options.format);
    const destination = resolveArchiveDestination(metadata, { repository: options.repository, tag: options.tag });
    const resolvedOptions = { ...options, ...destination, archive };
    if (options.format === 'docker' && archive.entries.has('manifest.json')) {
      return await uploadLegacyDockerArchive(resolvedOptions);
    }
    if (archive.entries.has('index.json')) {
      return await uploadOciArchive(resolvedOptions);
    }
    if (options.format === 'oci') {
      throw new RegistryRequestError('OCI archive must contain index.json', 422, 'INVALID_OCI_ARCHIVE');
    }
    return await uploadLegacyDockerArchive(resolvedOptions);
  } finally {
    await rm(archive.directory, { recursive: true, force: true });
  }
}

export function archiveFormat(value: string | undefined): RegistryArchiveFormat {
  if (value === 'docker' || value === 'oci') return value;
  throw new RegistryRequestError('Archive format must be docker or oci', 400, 'INVALID_ARCHIVE_FORMAT');
}

export function contentDispositionFilename(filename: string): string {
  return basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '-');
}

