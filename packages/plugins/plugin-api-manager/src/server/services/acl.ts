import type { Application } from '@nocobase/server';
import { ACL } from '@nocobase/acl';

/**
 * ACL integration for the API gateway.
 *
 * Gateway requests (/api/apim/*) bypass the resourcer pipeline, so they do not
 * run through the standard ACL middleware. Instead, when an API key is bound to
 * a NocoBase role (roleName), the gateway enforces the same ACL engine by
 * calling `acl.can()` directly with the key's role and the synthetic
 * `apimRoutes` resource/action pair:
 *
 *   resource: apimRoutes
 *   action:   call:<routeName>
 *
 * Admins can therefore grant "this role may call this route" either through the
 * role's snippets (per-route snippets registered by registerRouteSnippets, or
 * the all-routes snippet registered by registerAllRoutesSnippet) or through
 * `acl.define()` grants (grantRouteActionToRole). See ACL-INTEGRATION-NOTES.md
 * for the full design.
 */

export const APIM_ROUTES_RESOURCE = 'apimRoutes';

export function routeCallAction(routeName: string): string {
  return `call:${routeName}`;
}

export function routeSnippetName(routeName: string): string {
  return `pm.plugin-api-manager.routes.${routeName}`;
}

/**
 * Snippet name granting "call every API route" (registered by
 * registerAllRoutesSnippet). A role whose snippets contain this name may call
 * any route; per-route snippets take precedence for finer-grained grants.
 */
export const APIM_ROUTES_ALL_SNIPPET = 'pm.plugin-api-manager.routes';

/**
 * True when the role is allowed to call the route through the ACL engine.
 *
 * The role must hold either the per-route grant (apimRoutes:call:<routeName>),
 * the all-routes grant (apimRoutes:call:* via APIM_ROUTES_ALL_SNIPPET or an
 * explicit `apimRoutes:call:*` action), or be 'root'. Keys without a roleName
 * are legacy keys and are handled by the gateway directly (they keep working),
 * so this function is only invoked for role-bound keys.
 */
export function canRoleCallRoute(app: Application, roleName: string, routeName: string): boolean {
  const acl = app.acl as ACL;
  return Boolean(
    acl.can({
      role: roleName,
      resource: APIM_ROUTES_RESOURCE,
      action: routeCallAction(routeName),
    }),
  );
}

/**
 * Grant a role the right to call one route.
 *
 * NOTE: ACL core resource grants (`role.grantAction`) cannot express actions
 * whose name contains a colon (`split(':')` only keeps two segments), so the
 * per-route action `call:<routeName>` is only enforceable through SNIPPETS,
 * which are matched with minimatch on the full `resource:action` path. Granting
 * here therefore adds the per-route snippet to the role.
 */
export function grantRouteActionToRole(acl: ACL, roleName: string, routeName: string): void {
  const role = acl.getRole(roleName);
  if (!role) {
    return;
  }
  role.snippets.add(routeSnippetName(routeName));
}

/** Remove a role's right to call one route (removes the per-route snippet). */
export function revokeRouteActionFromRole(acl: ACL, roleName: string, routeName: string): void {
  const role = acl.getRole(roleName);
  if (!role) {
    return;
  }
  role.snippets.delete(routeSnippetName(routeName));
}

/**
 * Register per-route snippets so a role with
 * `pm.plugin-api-manager.routes.<routeName>` in its snippets may call the route.
 */
export function registerRouteSnippets(acl: ACL, routeNames: string[]): void {
  for (const routeName of routeNames) {
    acl.registerSnippet({
      name: routeSnippetName(routeName),
      actions: [`${APIM_ROUTES_RESOURCE}:${routeCallAction(routeName)}`],
    });
  }
}

/** Register the "call every API route" snippet (see APIM_ROUTES_ALL_SNIPPET). */
export function registerAllRoutesSnippet(acl: ACL): void {
  acl.registerSnippet({
    name: APIM_ROUTES_ALL_SNIPPET,
    actions: [`${APIM_ROUTES_RESOURCE}:call:*`],
  });
}

/**
 * Register the `apimRoutes` synthetic resource as an available action so the
 * Roles UI (plugin-acl) can list "call:<route>" grants. Only routes that
 * already exist are advertised; stale entries are re-registered each sync.
 */
export function syncApimRoutesAvailableActions(acl: ACL, routeNames: string[]): void {
  const registered = new Set<string>();
  for (const routeName of routeNames) {
    const actionName = routeCallAction(routeName);
    acl.setAvailableAction(actionName, {
      displayName: `Call API route "${routeName}"`,
      resource: APIM_ROUTES_RESOURCE,
      allowConfigureFields: false,
    });
    registered.add(actionName);
  }
  // Drop available actions for routes that no longer exist.
  for (const [actionName, action] of [...acl.getAvailableActions()]) {
    if (action.options.resource === APIM_ROUTES_RESOURCE && !registered.has(actionName)) {
      acl.getAvailableActions().delete(actionName);
    }
  }
}
