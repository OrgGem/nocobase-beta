// SPDX-License-Identifier: Apache-2.0

/**
 * Strip known prefixes from a model ID.
 */
const stripModelIdPrefix = (id: string): string => {
  let name = id;
  name = name.replace(/^ft:/, '');
  const slashIndex = name.lastIndexOf('/');
  if (slashIndex !== -1) {
    name = name.substring(slashIndex + 1);
  }
  return name;
};

const capitalize = (s: string) => (s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Merge consecutive short (<=2 digit) numeric segments with '.'.
 * e.g. ["claude","opus","4","5","20251101"] -> ["claude","opus","4.5","20251101"]
 */
const mergeVersionSegments = (segments: string[]): string[] => {
  const result: string[] = [];
  let i = 0;
  while (i < segments.length) {
    if (/^\d{1,2}$/.test(segments[i])) {
      let version = segments[i];
      while (i + 1 < segments.length && /^\d{1,2}$/.test(segments[i + 1])) {
        version += '.' + segments[i + 1];
        i++;
      }
      result.push(version);
    } else {
      result.push(segments[i]);
    }
    i++;
  }
  return result;
};

/**
 * Default fallback: space-separated, version-merged. Mirrors the upstream
 * default in @nocobase/plugin-ai (not exported from its client bundle).
 */
export const formatModelLabel = (id: string): string => {
  const name = stripModelIdPrefix(id);
  const segments = mergeVersionSegments(name.split(/[-_]/));
  return segments.map(capitalize).join(' ');
};
