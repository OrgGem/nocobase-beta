import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import AdmZip from 'adm-zip';
import { parseSkillMarkdown } from '../skill-hub/utils/json-fields';
export interface SkillPackageMetadata {
  path: string;
  metadata: Record<string, any>;
  instructions: string;
  code: string | null;
}

export class SkillRepositoryService {
  private baseDir: string;

  constructor(storagePath: string) {
    this.baseDir = resolve(storagePath, 'skills');
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Extract a zip file to the repository.
   * Returns parsed metadata from SKILL.md / skill.yaml
   */
  async extractSkillPackage(skillName: string, zipFilePath: string) {
    const targetDir = resolve(this.baseDir, skillName);
    
    // Clean target dir if exists
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(targetDir, { recursive: true });

    // Extract
    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(targetDir, true);

    return this.readSkillPackage(targetDir);
  }

  getSkillPath(skillName: string) {
    return resolve(this.baseDir, skillName);
  }

  getSkillCode(skillName: string): string | null {
    const dir = this.getSkillPath(skillName);
    if (!existsSync(dir)) return null;

    return this.getSkillCodeFromDir(dir);
  }

  copySkillPackageTo(skillName: string, destDir: string) {
    const srcDir = this.getSkillPath(skillName);
    this.copyDirectoryTo(srcDir, destDir);
  }

  readSkillPackage(packageDir: string): SkillPackageMetadata {
    const rootDir = resolve(packageDir);
    if (!existsSync(rootDir)) {
      return {
        path: rootDir,
        metadata: {},
        instructions: '',
        code: null,
      };
    }

    let metadata: Record<string, any> = {};
    let instructions = '';
    const skillMdPath = resolve(rootDir, 'SKILL.md');

    if (existsSync(skillMdPath)) {
      const content = readFileSync(skillMdPath, 'utf8');
      const parsed = parseSkillMarkdown(content);
      metadata = parsed.metadata;
      instructions = parsed.body;
    }

    instructions += this.aggregateOtherMarkdownFiles(rootDir);

    return {
      path: rootDir,
      metadata,
      instructions: instructions.trim(),
      code: this.getSkillCodeFromDir(rootDir),
    };
  }

  copyDirectoryTo(srcDir: string, destDir: string) {
    if (!existsSync(srcDir)) return;

    cpSync(srcDir, destDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const name = src.split(/[\\/]/).pop();
        return !['node_modules', '.git', '__pycache__'].includes(name || '') && !src.endsWith('.pyc');
      },
    });
  }



  private getSkillCodeFromDir(dir: string): string | null {
    if (existsSync(resolve(dir, 'index.py'))) {
      return readFileSync(resolve(dir, 'index.py'), 'utf8');
    }
    if (existsSync(resolve(dir, 'index.js'))) {
      return readFileSync(resolve(dir, 'index.js'), 'utf8');
    }
    if (existsSync(resolve(dir, 'main.py'))) {
      return readFileSync(resolve(dir, 'main.py'), 'utf8');
    }

    return null;
  }

  private aggregateOtherMarkdownFiles(dir: string, baseDir = dir): string {
    let combined = '';
    
    if (!existsSync(dir)) return combined;
    
    const items = readdirSync(dir);
    for (const item of items) {
      const fullPath = resolve(dir, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (item !== 'node_modules' && item !== '.git') {
          combined += this.aggregateOtherMarkdownFiles(fullPath, baseDir);
        }
      } else if (stat.isFile() && item.toLowerCase().endsWith('.md') && item.toUpperCase() !== 'SKILL.md') {
        const relPath = relative(baseDir, fullPath);
        const content = readFileSync(fullPath, 'utf8');
        combined += `\n\n--- Content from ${relPath} ---\n\n${content}`;
      }
    }
    
    return combined;
  }
}
