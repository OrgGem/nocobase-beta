export interface ResolvedAction {
  resourceName?: string;
  actionName?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const OPAQUE_ID = /^[0-9A-Za-z_-]{20,}$/;
export function normalizeOperation(action: ResolvedAction | undefined, path: string): string {
  if (action?.resourceName && action.actionName) return `${action.resourceName}:${action.actionName}`.slice(0, 160);
  return (path.split('?')[0] || '/')
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || UUID.test(segment) || OPAQUE_ID.test(segment) ? ':id' : segment.slice(0, 80),
    )
    .join('/')
    .slice(0, 160);
}
