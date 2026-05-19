import { NormalizedOcrItem, OcrMappingProfile, OcrPoint, OcrRect } from '../../shared/types';

type Ref = { value: any; path: Array<string | number> };

const splitPath = (path?: string) => {
  if (!path) return [];
  return path.split('.').filter(Boolean);
};

export function getByPath(source: any, path?: string) {
  if (!path) return source;
  return splitPath(path).reduce((node, key) => {
    if (node == null) return undefined;
    return node[key];
  }, source);
}

export function setByPath(source: any, path: string | undefined, value: any) {
  const parts = splitPath(path);
  if (!parts.length) return;
  let node = source;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

export function getManyByPath(source: any, path: string): Ref[] {
  const parts = splitPath(path);
  const walk = (node: any, index: number, currentPath: Array<string | number>): Ref[] => {
    if (index >= parts.length) return [{ value: node, path: currentPath }];
    const part = parts[index];
    const arrayMatch = part.match(/^(.+)\[\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const arr = node?.[key];
      if (!Array.isArray(arr)) return [];
      return arr.flatMap((item, itemIndex) => walk(item, index + 1, [...currentPath, key, itemIndex]));
    }
    return walk(node?.[part], index + 1, [...currentPath, part]);
  };
  return walk(source, 0, []);
}

function toRect(value: any): OcrRect | undefined {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, width, height] = value.map(Number);
    return { x, y, width, height };
  }
  if (typeof value === 'object') {
    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    const width = Number(value.width ?? value.w);
    const height = Number(value.height ?? value.h);
    if ([x, y, width, height].every(Number.isFinite)) {
      return { x, y, width, height, unit: value.unit };
    }
  }
  return undefined;
}

function toPoints(value: any): OcrPoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points = value
    .map((point) => {
      if (Array.isArray(point) && point.length >= 2) return { x: Number(point[0]), y: Number(point[1]) };
      if (point && typeof point === 'object') return { x: Number(point.x), y: Number(point.y) };
      return null;
    })
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  return points.length ? (points as OcrPoint[]) : undefined;
}

export function normalizeOcrJson(data: any, profile: OcrMappingProfile): NormalizedOcrItem[] {
  return getManyByPath(data, profile.itemsPath).map(({ value }) => ({
    id: String(getByPath(value, profile.idPath) ?? getByPath(value, profile.keyPath) ?? ''),
    key: String(getByPath(value, profile.keyPath) ?? ''),
    value: getByPath(value, profile.valuePath),
    page: Number(getByPath(value, profile.pagePath)) || undefined,
    rect: toRect(getByPath(value, profile.rectPath)),
    points: toPoints(getByPath(value, profile.pointsPath)),
    confidence: Number(getByPath(value, profile.confidencePath)) || undefined,
    status: getByPath(value, profile.statusPath),
  }));
}

export function applyOcrItemChanges(data: any, profile: OcrMappingProfile, changes: Array<Partial<NormalizedOcrItem>>) {
  const refs = getManyByPath(data, profile.itemsPath);
  const changed: Array<Partial<NormalizedOcrItem>> = [];

  for (const patch of changes || []) {
    const ref = refs.find(({ value }) => {
      const id = String(getByPath(value, profile.idPath) ?? '');
      const key = String(getByPath(value, profile.keyPath) ?? '');
      return (!!patch.id && id === String(patch.id)) || (!!patch.key && key === String(patch.key));
    });
    if (!ref) continue;
    if ('value' in patch) setByPath(ref.value, profile.valuePath, patch.value);
    if ('status' in patch && profile.statusPath) setByPath(ref.value, profile.statusPath, patch.status);
    changed.push(patch);
  }

  return changed;
}
