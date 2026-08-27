# ACL & Auth Integration Research — plugin-api-manager

> Tham chiếu cho phiên chuyển đổi api-key sang quản lý tập trung (ACL core NocoBase).
> Nguồn: `packages/core/acl`, `packages/core/auth`, `packages/core/server`, `packages/plugins/@nocobase/plugin-acl`, `packages/plugins/@nocobase/plugin-api-keys`, `packages/plugins/@nocobase/plugin-auth`.

## 1. Kiến trúc ACL core (`packages/core/acl/src`)

### 1.1 `ACL` class (`acl.ts`)
- `roles: Map<string, ACLRole>` — role in-memory.
- `availableStrategy: Map<string, ACLAvailableStrategy>` — strategy mặc định (vd `"2fa"`, custom).
- `allowManager: AllowManager` — skip-actions công khai.
- `snippets: SnippetManager` — đăng ký & kiểm tra snippet.
- `actionAlias: Map<string,string>` — alias action (`create`→`firstOrCreate`/`updateOrCreate`, `view`→`get`/`list`/`query`, `update`→`update`/`move`, `destroy`→`destroy`).
- `fixedParamsManager` — tham số cố định gắn vào `CanResult.params` khi grant.
- API chính:
  - `define({ role, strategy, actions, snippets })` / `getRole(name)` / `removeRole(name)`
  - `can({ roles, resource, action, rawResourceName, ctx }) → CanResult | null`
  - `middleware()` — Koa middleware gắn `ctx.acl`, `ctx.can`, `ctx.permission`.
  - `registerSnippet({ name, actions })`, `allow()/skip()` (public), `setAvailableAction(name, options)`, `getAvailableActions()`, `beforeGrantAction(fn)`.

### 1.2 Quyết định quyền (`getCanByRole` trong `acl.ts`)
Thứ tự quyết định cho từng role trong `roles[]`:
1. Nếu role === `'root'` → luôn cho phép (return `{ resource, action, role }`).
2. `actionPath = rawResourceName ?? resource : action`; check `snippetAllowed(actionPath)`.
3. `fixedParams = fixedParamsManager.getParams(resource, action)` — merge vào kết quả.
4. Nếu role có `aclResource` cho resource:
   - `aclResource.getAction(action)` (có alias) → nếu có params → cho phép + merge fixedParams.
   - Nếu resource tồn tại nhưng action không được grant → **từ chối** (return null).
5. Nếu không có resource riêng → dùng `roleStrategy.allow(resource, actionAlias)` (strategy cấp role).
6. Nếu snippet cho phép → cho phép với params rỗng.
7. Không khớp → null (từ chối).

Lưu ý: `ACLResource.getAction(action)` resolve alias; `mergeAclActionParams` gộp params.

### 1.3 `ACLRole` (`acl-role.ts`)
- `strategy: string | AvailableStrategyOptions`
- `resources: Map<string, ACLResource>`, `snippets: Set<string>`
- `grantAction(path, options)` → `resource:action`, tạo resource nếu chưa có, `setAction`.
- `revokeResource(name)` — xóa resource + `name.*`.
- `snippetAllowed(actionPath)` — dùng `SnippetManager.allow`, hỗ trợ `!snippet` (reject).

### 1.4 `ACLResource` (`acl-resource.ts`)
- `actions: Map<string, RoleActionParams>`; `getAction(name)` clone + uniq fields; `setAction(name, params)` emit `beforeGrantAction`.

### 1.5 `SnippetManager` (`snippet-manager.ts`)
- `register({ name, actions })` — name không chứa `*`/đuôi `.`; gộp actions trùng.
- `allow(actionPath, snippetName)` — `minimatch(actionPath, actionRule)`; trả `null` nếu không khớp; `!snippet` → reject.

### 1.6 `AllowManager` (`allow-manager.ts`)
- `allow(resourceName, actionName, condition)` — condition: `'public' | 'loggedIn' | 'allowConfigure' | ConditionFunc`.
- `isAllowed(resourceName, actionName, ctx)` — duyệt `['*', resourceName] × ['*', actionName]`, chạy condition; `public` → true.
- `aclMiddleware()` — nếu allowed → set `ctx.permission.skip = true`.

## 2. Luồng middleware request (server)

Thứ tự (resourcer/dataSource middlewares, `packages/core/data-source-manager/src/data-source.ts`):
```
auth (AuthManager.middleware, tag 'auth') 
  → setCurrentRole (plugin-acl, after 'auth', before 'acl') 
  → acl (ACL.middleware, tag 'acl', after 'auth') 
  → dataTemplate, validateFilterParams, ...
```
- `AuthManager.middleware()` (`packages/core/auth/src/auth-manager.ts`):
  - Đọc header `X-Authenticator` (mặc định `basic`) → `storer.get(name)` → `auth.check()`.
  - `auth.check()` (BaseAuth) → `checkToken()` → `jwt.decode(token)` → `{ userId, roleName }` → load user → `ctx.auth.user`.
  - Lỗi không auth → `ctx.auth = {}` (không throw) → các middleware sau tự quyết định.
- `setCurrentRole` (`plugin-acl/src/server/middlewares/setCurrentRole.ts`):
  - Header `X-Role: anonymous` → `ctx.state.currentRole = 'anonymous'`, bỏ qua.
  - Không có `ctx.state.currentUser` → next.
  - Load roles user từ cache `roles:<userId>` + `ctx.state.attachRoles` (union) → `ctx.state.currentUser.roles`.
  - `roleMode` (systemSettings): `default` → role từ `X-Role` hoặc default role; `onlyUseUnion` → `ctx.state.currentRoles = tất cả roles`.
  - Set `ctx.state.currentRole` (1 role) hoặc `ctx.state.currentRoles` (union).
- `ACL.middleware()` (`packages/core/acl/src/acl.ts`):
  - `roleName = ctx.state.currentRole || 'anonymous'`
  - `resourceName` resolve: strip `a.b` → `b`; nếu có `ctx.getCurrentRepository()?.targetCollection` → dùng tên collection.
  - `ctx.can({ resource, action, rawResourceName })` — dùng `ctx.state.currentRoles || [roleName]`.
  - `ctx.permission = { can, resourceName, actionName }`.
  - Chạy `compose(acl.middlewares.nodes)` (các middleware ACL như allowManager, setPermission).

Kết luận: **ACL check chỉ chạy trong resourcer pipeline** — request đi qua `resourceManager.middleware()`. Gateway `/api/apim/*` của plugin-api-manager được mount **ngoài** resourcer nên hiện **không** chạy ACL.

## 3. Vòng đời role → ACL (plugin-acl)

- `PluginACLServer.beforeLoad`:
  - `registerSnippet({ name: 'pm.<name>.roles', actions: [...] })` — quản trị roles.
  - `registerModels` (RoleModel, RoleResourceModel, RoleResourceActionModel).
  - `setAvailableAction` cho `create/view/update/destroy` (aliases) — `packages/core/server/src/acl/available-action.ts`.
- `load`:
  - `setCurrentRole` middleware (after 'auth', before 'acl').
  - Hook `roles.afterSaveWithAssociations` → `writeRoleToACL` → đồng bộ `dataSourcesRoles` → `app.emitAsync('acl:writeResources')`.
  - Hook `roles.afterDestroy` → `acl.removeRole`.
  - `users.afterCreateWithAssociations` → gán default role.
  - `writeRolesToACL()` — load tất cả roles (appends `resources`, `resources.actions`) → `writeToAcl` + từng resource.
- `RoleModel.writeToAcl({ acl })`:
  - `acl.define({ role })` nếu chưa có; set strategy `{ ...strategy, allowConfigure }`; `role.snippets = Set(snippets)`.
- `RoleResourceModel.writeToACL({ acl })`:
  - `role.revokeResource(resourceName)`; nếu `usingActionsConfig !== false` → `role.resources.set(name, resource)` → từng action `RoleResourceActionModel.writeToACL` → `role.grantAction(resource:action, { fields, own, filter })`.
- Collections: `roles` (name PK, strategy, snippets, resources hasMany `dataSourcesRolesResources`), `rolesResources`, `rolesResourcesActions` (fields, scope), `rolesResourcesScopes` (filter templates như `own`, `all`).

### Cách 1 plugin bên ngoài thêm resource/action vào role (không sửa plugin-acl)
- Đăng ký collection resource riêng (vd `apimRoutes`) + action handler riêng, **không** cần cấu trúc `dataSourcesRolesResources`.
- `acl.define({ role: roleName, actions: { 'apimRoutes:call:<routeName>': {} } })` — in-memory.
- Hoặc dùng **snippet**: `acl.registerSnippet({ name: 'pm.plugin-api-manager:routes.<routeName>', actions: ['apimRoutes:call:<routeName>'] })` → role cần có snippet name trong `roles.snippets`.

## 4. Auth & api-keys

### 4.1 `AuthManager` (`packages/core/auth/src/auth-manager.ts`)
- `authTypes: Registry<AuthConfig>` — `registerAuthType(name, { auth: AuthExtend, title, ... })`.
- `jwt: JwtService` — sign/verify; secret từ file `storage/apps/main/jwt_secret.dat` hoặc `APP_KEY`.
- `tokenController` — token control service (blacklist/renew).
- `storer: Storer` — đọc authenticator (collection `authenticators`) theo `authType`.
- `middleware()` — như mục 2.

### 4.2 `plugin-api-keys` (`@nocobase/plugin-api-keys`)
- Collection `apiKeys` (shared, `dumpRules.user`): `name`, `role` (belongsTo `roles`, FK `roleName`), `expiresIn`, `token` (hidden).
- Actions: `create` — user tự tạo key cho **chính mình**, chọn 1 role mà user sở hữu (`users.roles`), sign JWT `{ userId, roleName }`, block token khi destroy.
- **Không có Auth class riêng** — dùng JWT chuẩn của `BaseAuth.checkToken()` → `ctx.auth.user` + `roleName` trong payload → `setCurrentRole` xử lý roles bình thường.
- ACL snippet: `pm.<name>.configuration` = `apiKeys:list/create/destroy`.
- Middleware tự thêm filter `createdById: ctx.auth.user.id` cho list/destroy (mỗi user chỉ quản key của mình).
- Điểm mấu chốt: **api-key = JWT của user + roleName**, không có "key riêng biệt" — nên ACL core chạy đúng (user + role thật).

## 5. Hiện trạng plugin-api-manager

- Collection `apiManagerApiKeys`: `name`, `partnerId`, `keyHash` (sha256, unique), `keyPrefix`, `scopes` (json, vd `["inbound","outbound:orders"]`), `expiresAt`, `lastUsedAt`, `revokedAt`, `enabled`.
- Auth gateway (`src/server/gateway/auth.ts`): tự hash key → tìm `apiManagerApiKeys` → check enabled/expires/revoked → check **scope** `inbound|outbound[:route]` → cập nhật `lastUsedAt` → trả `{ apiKeyId, partnerId, scopes }`.
- Gateway router (`src/server/gateway/router.ts`): mount tại `/api/apim/inbound/:name` và `/api/apim/outbound/:name` **ngoài resourcer** → **không đi qua auth manager / ACL**.
- ACL hiện tại chỉ bảo vệ admin CRUD (snippet `pm.plugin-api-manager`: `apiRoutes:*`, `apiPartners:*`, `apiManagerApiKeys:*`, `apiRequestLogs:list/get`, `apiManagerSettings:get/save`, `apiManager:health`).
- Quản trị: `registerApiKeysResource` (create trả plaintext 1 lần, revoke), `registerRoutesResource`, `registerApiManagerSettingsResource`, `registerHealthResource`.

## 6. Hướng chuyển đổi sang ACL core (feasibility)

### 6.1 Phương án A — Giữ collection riêng, thêm `roleName` + gọi ACL trong gateway (khuyến nghị, ít rủi ro)
1. Thêm field `roleName` (belongsTo `roles`) vào `apiManagerApiKeys` + migration.
2. Khi tạo key: bắt buộc chọn role mà người tạo sở hữu (giống `plugin-api-keys`) — validate `users.roles`.
3. Trong `gateway/auth.ts`, sau khi xác thực key: set `ctx.state.currentRole = roleName; ctx.state.currentRoles = [roleName]`.
4. Gateway router gọi ACL check trước khi forward:
   - Option 1 (đơn giản nhất): `app.acl.can({ role: roleName, resource: 'apimRoutes', action: '<routeName>' })`.
   - Option 2 (mở rộng nhất): cấu hình role–route qua UI roles → `acl.define({ role, actions: { 'apimRoutes:call:<routeName>': {} } })` hoặc snippets `pm.plugin-api-manager:routes.<routeName>`.
5. Ưu điểm: không đụng core, không đụng `plugin-acl`/`plugin-api-keys`; gateway vẫn xử lý mã hóa/rate-limit/retry như cũ; thêm `X-Role` semantics rõ ràng.
6. Rủi ro: phải tự gọi `acl.can` (gateway ngoài resourcer); cần invalidate/cache roles đúng cách; migration dữ liệu key cũ.

### 6.2 Phương án B — Dùng `plugin-api-keys` + auth manager (đồng bộ tối đa)
- Thay `apiManagerApiKeys` bằng `apiKeys` của `@nocobase/plugin-api-keys` (JWT `{ userId, roleName }`) → `auth.check()` tự set user+role → ACL core chạy đúng chuẩn.
- Gateway cần mount trong resourcer pipeline hoặc tự gọi `authManager.middleware()` + `setCurrentRole` + `acl` cho path `/api/apim/*`.
- Ưu điểm: kế thừa toàn bộ (renew, blacklist, role quản lý tập trung, UI sẵn có).
- Nhược điểm: mất tính năng riêng của `apiManagerApiKeys` (partnerId, scopes inbound/outbound, lastUsedAt, keyPrefix) — phải thêm extension hoặc giữ song song; phụ thuộc `plugin-api-keys` (base plugin) phải bật.

### 6.3 Phương án C — Hybrid (đề xuất dài hạn)
- Giữ `apiManagerApiKeys` cho key gateway, **thêm** trường `roleName` + `userId` tùy chọn.
- Tạo **custom Auth type** `apim-key` (`app.authManager.registerAuthType('apim-key', { auth: ApimApiKeyAuth })`) để `AuthManager.middleware()` nhận diện header `X-API-Key`/`X-Authenticator: apim-key` trên path gateway.
- Auth class này: hash key → tìm record → set `ctx.auth.user` (user ảo/real) + `ctx.state.currentRole`/`currentRoles` + `attachRoles` → sau đó chạy `acl.middleware()` → gateway check `ctx.permission.can`.
- Cho phép cấu hình phân quyền role–route ngay trong UI Roles (thêm resource `apimRoutes` + actions `call:<routeName>` qua snippet/define).

### 6.4 Đánh giá khả thi
- **Khả thi cao**: ACL core API đủ (`can`, `define`, `registerSnippet`, `middleware`); plugin-acl đã có cơ chế đồng bộ role→ACL.
- **Điểm cần xử lý**:
  - Gateway ngoài resourcer → phải tự gọi ACL (dùng `app.acl.can` trực tiếp — không cần middleware đầy đủ) hoặc chuyển gateway vào resourcer.
  - `ctx.state.currentRoles` phải được set trước khi check (vai trò của `setCurrentRole`).
  - Cache roles: nếu dùng user thật, dùng cache `roles:<userId>` sẵn có; nếu roleName gắn trên key, cache theo key.
  - Phân quyền "thấy route" (view) dùng `apimRoutes:view`/`apiRoutes:get|list`; "call route" dùng action riêng.
  - Không được sửa `packages/core/**`, `@nocobase/plugin-acl`, `@nocobase/plugin-api-keys` (upstream contracts) — chỉ extend qua API public (registerAuthType, registerSnippet, acl.define, acl.can).

## 7. Thiết kế phân quyền đề xuất (từ quản trị module → call route)

| Cấp | Quyền | Cơ chế |
|-----|-------|--------|
| Super Admin | Toàn quyền | role `root` |
| API Manager Admin | CRUD routes/partners/keys, xem logs, settings | snippet `pm.plugin-api-manager` |
| API Route Editor | Tạo/sửa route, xem keys, KHÔNG tạo key | `apiRoutes:*` (view/create/update/destroy), `apiPartners:*`, `apiManagerApiKeys:list/get` |
| API Route Caller | Chỉ call route qua gateway | action `apimRoutes:call:<routeName>` (hoặc snippet `pm.plugin-api-manager:routes.<routeName>`) |
| API Key Holder | Dùng key để call route được gán | roleName trên key + scope `inbound/outbound:route` |

Mapping UI Roles:
- Roles management (plugin-acl) hiển thị thêm tab/resource `apimRoutes` với actions: `view` (thấy route), `call:<route>` (gọi route).
- API Key form: chọn role (phải thuộc user tạo) + scopes; nếu role không có quyền `call:<route>` → gateway trả 403.

## 8. Checklist triển khai (phiên sau)
1. Migration: thêm `roleName` (FK roles) vào `apiManagerApiKeys` (nullable, backfill).
2. `resources/api-keys.ts`: validate role thuộc user, lưu roleName; trả về thông tin role.
3. `gateway/auth.ts`: trả `roleName` trong `AuthResult`; set `ctx.state.currentRole(s)`.
4. `gateway/router.ts`: sau IP allowlist + auth → `acl.can({ role: roleName, resource: 'apimRoutes', action: routeName })` (hoặc snippet) → 403 nếu không được phép.
5. Đăng ký resource `apimRoutes` + availableActions (`call:<route>` động theo route) để UI roles hiển thị.
6. UI v1/v2: thêm role selector trong API Keys tab; hiển thị "route permissions" của role.
7. Test: unit test auth/ACL; integration test 403 khi role thiếu quyền; test migration backfill; test song song mã hóa/không mã hóa.
