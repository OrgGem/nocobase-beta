import { mkdirSync, readdirSync, statSync, existsSync, rmSync, chownSync } from 'fs';
import { resolve, join } from 'path';

export interface OutputFileInfo {
  name: string;
  size: number;
  mimeType: string;
}

const MIME_MAP: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.html': 'text/html',
  '.xml': 'application/xml',
};

function getMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export class FileManager {
  private executionsDir: string;

  constructor(private storagePath: string) {
    this.executionsDir = resolve(storagePath, 'executions');
    mkdirSync(this.executionsDir, { recursive: true });
  }

  createExecDir(execId: string): string {
    const dir = resolve(this.executionsDir, execId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(resolve(dir, 'output'), { recursive: true });
    return dir;
  }

  getExecDir(execId: string): string {
    return resolve(this.executionsDir, execId);
  }

  getOutputDir(execId: string): string {
    return resolve(this.executionsDir, execId, 'output');
  }

  /**
   * Hand the execution directory to the dropped-privilege sandbox user so the
   * child can read its script and write output. Requires root (chown), which
   * matches the only case privilege drop is active.
   */
  chownExecDir(execId: string, uid: number, gid: number): void {
    const dir = resolve(this.executionsDir, execId);
    chownSync(dir, uid, gid);
    // Direct children too (script + output dir): under a restrictive umask
    // (e.g. 077) the root-written script would stay unreadable for the sandbox uid.
    for (const entry of readdirSync(dir)) {
      chownSync(resolve(dir, entry), uid, gid);
    }
  }

  /**
   * Returns absolute path to an output file, or null if invalid/not found.
   * Includes path traversal protection.
   */
  getOutputFilePath(execId: string, filename: string): string | null {
    const safeBase = resolve(this.executionsDir, execId, 'output');
    const filePath = resolve(safeBase, filename);

    // Path traversal protection
    if (!filePath.startsWith(safeBase)) {
      return null;
    }
    if (!existsSync(filePath)) {
      return null;
    }
    return filePath;
  }

  listOutputFiles(execId: string): OutputFileInfo[] {
    const outputDir = this.getOutputDir(execId);
    if (!existsSync(outputDir)) return [];

    try {
      return readdirSync(outputDir)
        .filter((name) => {
          const filePath = join(outputDir, name);
          return statSync(filePath).isFile();
        })
        .map((name) => {
          const filePath = join(outputDir, name);
          const stat = statSync(filePath);
          return {
            name,
            size: stat.size,
            mimeType: getMimeType(name),
          };
        });
    } catch {
      return [];
    }
  }

  getTotalOutputSize(execId: string): number {
    const files = this.listOutputFiles(execId);
    return files.reduce((sum, f) => sum + f.size, 0);
  }

  /**
   * Remove a specific execution directory by execId.
   */
  removeExecDir(execId: string): void {
    const dirPath = resolve(this.executionsDir, execId);
    if (existsSync(dirPath)) {
      try {
        rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // Skip errors
      }
    }
  }

  /**
   * Remove execution directories older than maxAgeMs.
   */
  cleanupOlderThan(maxAgeMs: number): number {
    if (!existsSync(this.executionsDir)) return 0;

    let cleaned = 0;
    const now = Date.now();

    try {
      for (const dir of readdirSync(this.executionsDir)) {
        const dirPath = resolve(this.executionsDir, dir);
        try {
          const stat = statSync(dirPath);
          if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
            rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {
          // Skip individual dir errors
        }
      }
    } catch {
      // Skip if executionsDir not accessible
    }

    return cleaned;
  }
}
