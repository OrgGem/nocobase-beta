import { PlaceholderNodeView, PlaceholderSchemaView } from './PlaceholderTree';

/**
 * Build a JSON skeleton from a placeholder schema, using sensible mock values
 * by inferred type. The output mirrors what Carbone expects:
 *
 *   { d: { ... }, c: { ... } }
 *
 * Arrays get one element so the user can see the shape; nested objects are
 * filled recursively. Booleans alternate to make the generated sample obvious.
 */
export function buildSampleData(schema?: PlaceholderSchemaView | null): Record<string, unknown> {
  if (!schema) return {};
  const out: Record<string, unknown> = {};
  if (schema.d?.length) Object.assign(out, nodesToObject(schema.d));
  return out;
}

function nodesToObject(nodes: PlaceholderNodeView[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const n of nodes) obj[n.name] = nodeToValue(n);
  return obj;
}

function nodeToValue(n: PlaceholderNodeView): unknown {
  if (n.type === 'array') {
    return n.children?.length ? [nodesToObject(n.children)] : [];
  }
  if (n.type === 'object') {
    return n.children?.length ? nodesToObject(n.children) : {};
  }
  return mockScalar(n);
}

function mockScalar(n: PlaceholderNodeView): unknown {
  switch (n.type) {
    case 'number':
      return 123;
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'boolean':
      return true;
    default:
      return `Sample ${n.name}`;
  }
}
