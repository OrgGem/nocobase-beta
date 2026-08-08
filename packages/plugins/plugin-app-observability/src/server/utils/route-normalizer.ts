export interface ResolvedAction {
  resourceName?: string;
  actionName?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const OPAQUE_ID = /^[0-9A-Za-z_-]{20,}$/;
const NAME = '[A-Za-z0-9_.-]+';
// `/api/users:list`, `/api/users:get/42`, `/api/users/1/orders:list`
const RESOURCE_ACTION = new RegExp(`(?:^|/)(?:(${NAME})/[^/]+/)?(${NAME}):(${NAME})(?:/|$)`);

export function normalizeOperation(action: ResolvedAction | undefined, path: string): string {
  if (action?.resourceName && action.actionName) return `${action.resourceName}:${action.actionName}`.slice(0, 160);
  const pathname = path.split('?')[0] || '/';
  const matched = RESOURCE_ACTION.exec(pathname);
  if (matched) {
    const [, associated, resource, actionName] = matched;
    return `${associated ? `${associated}.${resource}` : resource}:${actionName}`.slice(0, 160);
  }
  return pathname
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || UUID.test(segment) || OPAQUE_ID.test(segment) ? ':id' : segment.slice(0, 80),
    )
    .join('/')
    .slice(0, 160);
}
