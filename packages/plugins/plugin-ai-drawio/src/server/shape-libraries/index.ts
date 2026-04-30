import fs from 'fs';
import path from 'path';

export const SHAPE_LIBRARY_NAMES = [
  'aws4',
  'azure2',
  'gcp2',
  'alibaba_cloud',
  'openstack',
  'salesforce',
  'cisco19',
  'network',
  'kubernetes',
  'vvd',
  'rack',
  'bpmn',
  'lean_mapping',
  'flowchart',
  'basic',
  'arrows2',
  'infographic',
  'sitemap',
  'android',
  'citrix',
  'sap',
  'mscae',
  'atlassian',
  'fluidpower',
  'electrical',
  'pid',
  'cabinets',
  'floorplan',
  'webicons',
] as const;

export type ShapeLibraryName = (typeof SHAPE_LIBRARY_NAMES)[number];

const cache = new Map<string, string | null>();

/**
 * Load a shape library doc.
 * Markdown lives under `src/ai/shape-libraries/*.md` so NocoBase's build
 * picks them up via `appendAiFiles` (see packages/core/build/src/buildPlugin.ts).
 * After build the files end up at `dist/ai/shape-libraries/*.md`, while this
 * file compiles to `dist/server/shape-libraries/index.js` — both layouts are
 * resolved relative to __dirname.
 */
const SHAPE_LIB_DIR = path.resolve(__dirname, '..', '..', 'ai', 'shape-libraries');

export async function loadShapeLibrary(library: string): Promise<string | null> {
  const sanitized = library.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!sanitized || sanitized !== library.toLowerCase()) return null;
  if (cache.has(sanitized)) return cache.get(sanitized)!;

  const filePath = path.resolve(SHAPE_LIB_DIR, `${sanitized}.md`);
  if (!filePath.startsWith(SHAPE_LIB_DIR + path.sep) && filePath !== SHAPE_LIB_DIR) {
    cache.set(sanitized, null);
    return null;
  }

  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    cache.set(sanitized, content);
    return content;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.error(`[plugin-ai-drawio] Failed to load shape library "${library}":`, e);
    }
    cache.set(sanitized, null);
    return null;
  }
}
