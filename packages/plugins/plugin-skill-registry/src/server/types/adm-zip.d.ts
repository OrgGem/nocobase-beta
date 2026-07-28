declare module 'adm-zip' {
  export type ZipEntry = {
    entryName: string;
    isDirectory: boolean;
    header: {
      size: number;
      compressedSize: number;
      time: Date;
    };
    getData(): Buffer;
  };

  export default class AdmZip {
    addFile(entryName: string, content: Buffer, comment?: string, attr?: number): ZipEntry;
    getEntries(): ZipEntry[];
    readAsText(entry: ZipEntry, encoding?: BufferEncoding): string;
    toBuffer(): Buffer;
    constructor(buffer?: Buffer);
  }
}
