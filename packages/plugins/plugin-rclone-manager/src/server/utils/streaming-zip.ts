// SPDX-License-Identifier: Apache-2.0

import { Readable } from 'node:stream';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, chunk: Buffer): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i++) {
    c = CRC32_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime =
    ((date.getUTCHours() & 0x1f) << 11) | ((date.getUTCMinutes() & 0x3f) << 5) | ((date.getUTCSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getUTCMonth() + 1) & 0x0f) << 5) | (date.getUTCDate() & 0x1f);
  return { dosTime, dosDate };
}

export interface StreamingZipEntry {
  /** Relative POSIX path inside the ZIP archive (UTF-8 supported). */
  name: string;
  modTime?: Date;
  openStream: () => Promise<Readable>;
}

interface CentralDirRecord {
  nameBuf: Buffer;
  crc: number;
  size: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}

export const MAX_ZIP32_BYTES = 0xffffffff;
export const MAX_ZIP32_ENTRIES = 65_535;

/**
 * Create a standard PKZIP (Store + UTF-8 + Data Descriptor) readable stream
 * with O(1) memory overhead — no temporary files and no extra npm packages.
 */
export function createStreamingZip(entries: readonly StreamingZipEntry[], signal?: AbortSignal): Readable {
  if (entries.length > MAX_ZIP32_ENTRIES) {
    throw new Error(`ZIP archive exceeds ${MAX_ZIP32_ENTRIES} entries limit`);
  }

  let activeStream: Readable | null = null;
  const destroyActiveStream = () => {
    if (activeStream && !activeStream.destroyed) {
      activeStream.destroy();
    }
  };
  signal?.addEventListener('abort', destroyActiveStream, { once: true });

  async function* generate(): AsyncGenerator<Buffer> {
    const centralRecords: CentralDirRecord[] = [];
    let offset = 0;
    // Bit 3 (0x0008): CRC & sizes follow in data descriptor; Bit 11 (0x0800): UTF-8 filename
    const flags = 0x0008 | 0x0800;

    try {
      for (const entry of entries) {
        signal?.throwIfAborted();
        const cleanName = entry.name.replace(/^\/+/, '').replace(/\\/g, '/');
        if (!cleanName) continue;

        const nameBuf = Buffer.from(cleanName, 'utf8');
        const { dosTime, dosDate } = toDosTimeDate(entry.modTime ?? new Date());
        const localHeaderOffset = offset;
        if (localHeaderOffset > MAX_ZIP32_BYTES) {
          throw new Error('ZIP archive exceeds 4 GiB PKZIP32 limit');
        }

        // Local File Header (30 bytes + filename)
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4); // version needed: 2.0
        localHeader.writeUInt16LE(flags, 6);
        localHeader.writeUInt16LE(0, 8); // compression: 0 (store)
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(0, 14); // crc32 in descriptor
        localHeader.writeUInt32LE(0, 18); // compressed size in descriptor
        localHeader.writeUInt32LE(0, 22); // uncompressed size in descriptor
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28); // extra field length

        yield localHeader;
        yield nameBuf;
        offset += localHeader.length + nameBuf.length;

        let crc = 0;
        let size = 0;
        const stream = await entry.openStream();
        activeStream = stream;
        try {
          signal?.throwIfAborted();
          for await (const rawChunk of stream) {
            signal?.throwIfAborted();
            const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
            if (buf.length === 0) continue;
            crc = updateCrc32(crc, buf);
            size += buf.length;
            offset += buf.length;
            if (size > MAX_ZIP32_BYTES || offset > MAX_ZIP32_BYTES) {
              throw new Error('ZIP archive exceeds 4 GiB PKZIP32 limit');
            }
            yield buf;
          }
        } finally {
          activeStream = null;
          if (!stream.destroyed) {
            stream.destroy();
          }
        }

        // Data Descriptor (16 bytes with PK\x07\x08 signature)
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(size >>> 0, 8);
        descriptor.writeUInt32LE(size >>> 0, 12);
        yield descriptor;
        offset += descriptor.length;

        centralRecords.push({
          nameBuf,
          crc,
          size,
          localHeaderOffset,
          dosTime,
          dosDate,
        });
      }

      const centralDirOffset = offset;
      let centralDirSize = 0;

      for (const rec of centralRecords) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(flags, 8);
        header.writeUInt16LE(0, 10); // store
        header.writeUInt16LE(rec.dosTime, 12);
        header.writeUInt16LE(rec.dosDate, 14);
        header.writeUInt32LE(rec.crc >>> 0, 16);
        header.writeUInt32LE(rec.size >>> 0, 20);
        header.writeUInt32LE(rec.size >>> 0, 24);
        header.writeUInt16LE(rec.nameBuf.length, 28);
        header.writeUInt16LE(0, 30); // extra length
        header.writeUInt16LE(0, 32); // comment length
        header.writeUInt16LE(0, 34); // disk number start
        header.writeUInt16LE(0, 36); // internal attrs
        header.writeUInt32LE(0, 38); // external attrs
        header.writeUInt32LE(rec.localHeaderOffset >>> 0, 42);

        yield header;
        yield rec.nameBuf;
        centralDirSize += header.length + rec.nameBuf.length;
      }

      // End of Central Directory Record (22 bytes)
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4); // disk number
      eocd.writeUInt16LE(0, 6); // central dir start disk
      eocd.writeUInt16LE(centralRecords.length, 8);
      eocd.writeUInt16LE(centralRecords.length, 10);
      eocd.writeUInt32LE(centralDirSize >>> 0, 12);
      eocd.writeUInt32LE(centralDirOffset >>> 0, 16);
      eocd.writeUInt16LE(0, 20); // comment length
      yield eocd;
    } finally {
      signal?.removeEventListener('abort', destroyActiveStream);
      destroyActiveStream();
    }
  }

  const zipStream = Readable.from(generate());
  zipStream.once('close', () => {
    signal?.removeEventListener('abort', destroyActiveStream);
    destroyActiveStream();
  });
  return zipStream;
}
