import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import AdmZip from 'adm-zip';

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

    // Read SKILL.md or package.json
    let metadata: any = {};
    const skillMdPath = resolve(targetDir, 'SKILL.md');
    
    if (existsSync(skillMdPath)) {
      const content = readFileSync(skillMdPath, 'utf8');
      metadata = this.parseFrontmatter(content);
    }
    
    return {
      path: targetDir,
      metadata
    };
  }

  getSkillPath(skillName: string) {
    return resolve(this.baseDir, skillName);
  }

  getSkillCode(skillName: string): string | null {
    const dir = this.getSkillPath(skillName);
    if (!existsSync(dir)) return null;

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

  copySkillPackageTo(skillName: string, destDir: string) {
    const srcDir = this.getSkillPath(skillName);
    if (existsSync(srcDir)) {
      cpSync(srcDir, destDir, { recursive: true, force: true });
    }
  }

  private parseFrontmatter(markdown: string) {
    // Basic regex to pull YAML out of markdown frontmatter
    const match = markdown.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    
    const yamlString = match[1];
    const result: any = {};
    
    yamlString.split('\n').forEach(line => {
      const parts = line.split(':');
      if (parts.length > 1) {
        const key = parts[0].trim();
        const value = parts.slice(1).join(':').trim();
        if (key) {
          result[key] = value;
        }
      }
    });

    return result;
  }
}
