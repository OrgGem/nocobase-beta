# Plan: Tích hợp AWS ECR vào plugin-docker-registry-ui

## 1. Mục tiêu

Bổ sung AWS ECR (Elastic Container Registry) như một credential mode mới `ecr` cho `plugin-docker-registry-ui`, cho phép:

- Kết nối ECR private registry qua Docker Distribution HTTP API V2 (data plane).
- **Token rotation tự động**: token ECR hết hạn sau 12 giờ → tự xin token mới qua `GetAuthorizationToken`, cache + single-flight + refresh buffer + force-refresh khi gặp 401.
- **IAM role trên EC2**: dùng default credential chain (IMDSv2) khi NocoBase chạy trên EC2 có instance profile; hỗ trợ thêm static credentials và assume-role (cross-account) cho các môi trường khác.
- **Catalog fallback**: ECR không hỗ trợ `GET /v2/_catalog` → dùng ECR Control Plane API (`DescribeRepositories` / `ListImages`) để liệt kê repositories và tags.
- UI config đầy đủ trên trang Settings + i18n (en-US, vi-VN, zh-CN).
- Unit test với mock AWS SDK (dependency injection, không cần AWS thật).

## 2. Kiến trúc

```
┌────────────────────────────────────────────────────────────────────┐
│ RegistryClient (per-request)                                       │
│  ├─ authorizationHeader()  → async                                 │
│  │    ├─ credentialMode='ecr' → EcrAuthProvider.getAuthorizationHeader() │
│  │    └─ basic/bearer/anonymous → logic hiện tại (sync)            │
│  ├─ requestUrl()/requestStreaming()                                │
│  │    └─ 401 + mode='ecr' → forceRefresh() → retry 1 lần           │
│  └─ listRepositoriesPage()/listTagsPage()                          │
│       └─ mode='ecr' → EcrCatalogProvider (DescribeRepositories/ListImages) │
│                                                                     │
│ EcrAuthProvider (services/ecr-auth.ts)                             │
│  ├─ GetAuthorizationToken → authorizationToken (base64 "AWS:<pwd>")│
│  ├─ Cache module-level: Map<region|host, {token, expiresAt}>       │
│  ├─ Single-flight: Map<key, Promise> (chung giữa các request)      │
│  ├─ Refresh buffer: 30 phút trước expiresAt                        │
│  └─ Credential resolution: roleArn → STS | static → direct | none → default chain │
│                                                                     │
│ EcrCatalogProvider (services/ecr-catalog.ts)                        │
│  ├─ DescribeRepositories → repositories (pagination nextToken)     │
│  └─ ListImages → tags (lọc imageTag null)                          │
└────────────────────────────────────────────────────────────────────┘
```

### Quyết định thiết kế

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Thêm credential mode `ecr`, không tự detect theo host | Tránh hành vi bất ngờ; ECR feature chỉ kích hoạt khi người dùng chọn mode `ecr` |
| D2 | `authorizationHeader()` chuyển thành async | Tất cả caller (`requestUrl`, `requestStreaming`, `health`) đều đã async — không breaking |
| D3 | Cache + single-flight ở module-level (giống `tokenCache` hiện tại) | `RegistryClient` là per-request nhưng token ECR 12h phải dùng chung giữa các request |
| D4 | DI qua tham số `createClient` cho EcrAuthProvider/EcrCatalogProvider | Test được với mock mà không cần `vi.mock` package; production dùng dynamic `require` |
| D5 | AWS SDK là `devDependencies` + dynamic require (theo pattern `plugin-s3-private-storage`) | Không tạo hard runtime dependency; build bundle được |
| D6 | Giữ nguyên `DELETE /v2/{name}/manifests/{digest}` cho delete | ECR hỗ trợ endpoint này; `BatchDeleteImage` là tối ưu tương lai, không chặn release |
| D7 | `tags/list` giữ nguyên qua V2 API | ECR hỗ trợ `GET /v2/{name}/tags/list` — chỉ `_catalog` cần fallback |
| D8 | UI render field theo credential mode (ẩn field không liên quan) | Cải thiện UX; hiện tại render tất cả field |

## 3. Thay đổi chi tiết theo file

### 3.1 `package.json` (plugin-docker-registry-ui)

Thêm `devDependencies` (version khớp `plugin-s3-private-storage`):

```json
"@aws-sdk/client-ecr": "3.750.0",
"@aws-sdk/credential-provider-node": "3.750.0",
"@aws-sdk/nested-clients": "3.750.0"
```

### 3.2 `src/shared/types.ts`

```ts
// Mở rộng
export type CredentialMode = 'anonymous' | 'basic' | 'bearer' | 'ecr';

// RegistrySettingsInput thêm:
awsRegion?: string;
awsRoleArn?: string;
awsAccessKeyId?: string;
awsSecretAccessKey?: string;
clearAwsAccessKeyId?: boolean;
clearAwsSecretAccessKey?: boolean;

// SafeRegistrySettings thêm:
awsRegion: string;
awsRoleArn: string;
hasAwsAccessKeyId: boolean;
hasAwsSecretAccessKey: boolean;

// RegistryConnection thêm:
awsAccessKeyId?: string;
awsSecretAccessKey?: string;
```

### 3.3 `src/server/collections/docker-registry-settings.ts`

Thêm 4 field:

```ts
{ name: 'awsRegion', type: 'string', defaultValue: '' },
{ name: 'awsRoleArn', type: 'string', defaultValue: '' },
{ name: 'awsAccessKeyIdCiphertext', type: 'text', hidden: true },
{ name: 'awsSecretAccessKeyCiphertext', type: 'text', hidden: true },
```

### 3.4 `src/server/services/settings.ts`

- `DEFAULTS`: thêm `awsRegion: ''`, `awsRoleArn: ''`.
- `safeSettings()`: thêm `awsRegion`, `awsRoleArn`, `hasAwsAccessKeyId: Boolean(row.awsAccessKeyIdCiphertext)`, `hasAwsSecretAccessKey: Boolean(row.awsSecretAccessKeyCiphertext)`.
- `mergeSettings()`:
  - Cho phép `'ecr'` trong danh sách credential mode hợp lệ.
  - Nếu `credentialMode === 'ecr'`: `awsRegion` bắt buộc (trim, non-empty) → nếu thiếu throw `RegistryConfigurationError('AWS region is required for ECR registries')`.
  - `awsRoleArn`: nếu non-empty, validate format `/^arn:aws(?:-cn|-us-gov)?:iam::\d{12}:role\/.+$/` → sai format throw error.
- `getRegistryConnection()`: decrypt `awsAccessKeyId` / `awsSecretAccessKey` từ ciphertext (theo pattern `secret()` hiện có).
- `updateRegistrySettings()`: thêm 2 cặp secret vào `secretUpdates`: `['awsAccessKeyId', 'awsAccessKeyIdCiphertext', 'clearAwsAccessKeyId']` và `['awsSecretAccessKey', 'awsSecretAccessKeyCiphertext', 'clearAwsSecretAccessKey']`.

### 3.5 `src/server/services/ecr-auth.ts` (MỚI)

```ts
export interface EcrClientLike {
  send(command: { input: unknown }): Promise<{
    authorizationData?: Array<{ authorizationToken?: string; expiresAt?: Date }>;
  }>;
}

export interface EcrAuthOptions {
  region: string;
  registryHost: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  roleArn?: string;
  createClient?: (config: { region: string; credentials?: unknown }) => EcrClientLike;
}

export class EcrAuthProvider {
  constructor(options: EcrAuthOptions);
  async getAuthorizationHeader(): Promise<string>; // `Basic <authorizationToken>`
  async forceRefresh(): Promise<void>;             // invalidate cache + refetch
  async validate(): Promise<void>;                 // gọi GetAuthorizationToken, dùng cho testConnection
}
```

**Logic token rotation:**

```
REFRESH_BUFFER_MS = 30 * 60_000   // refresh trước 30 phút
FALLBACK_TTL_MS   = 12 * 60 * 60_000  // nếu expiresAt thiếu

getToken():
  1. cacheKey = `${region}|${registryHost}`
  2. cached = ecrTokenCache.get(cacheKey)
     → nếu cached.expiresAt > now + REFRESH_BUFFER_MS → return cached.token
  3. refreshPromise = ecrRefreshPromises.get(cacheKey)
     → nếu có → await (single-flight chung giữa request)
  4. fetchToken():
     - resolve client (roleArn → STS AssumeRole qua @aws-sdk/nested-clients;
       static → credentials trực tiếp; none → undefined = default chain/IMDS)
     - client.send(GetAuthorizationTokenCommand)
     - token = authorizationData[0].authorizationToken  // đã là base64 "AWS:<pwd>"
     - expiresAt = authorizationData[0].expiresAt ?? now + FALLBACK_TTL_MS
     - lưu cache, xóa khỏi ecrRefreshPromises
  5. return token
```

**Credential resolution** — copy pattern từ `plugin-s3-private-storage/src/server/aws-credentials.ts`:
1. `roleArn` → `@aws-sdk/nested-clients/sts` `AssumeRoleCommand`, base = static creds hoặc `@aws-sdk/credential-provider-node` default chain.
2. `accessKeyId + secretAccessKey` → dùng trực tiếp.
3. Không có gì → `undefined` → SDK tự resolve (EC2 instance profile / IMDSv2).

**Lưu ý:** `authorizationToken` từ ECR đã là base64 → dùng thẳng làm giá trị `Authorization: Basic <token>`, không decode/re-encode.

### 3.6 `src/server/services/ecr-catalog.ts` (MỚI)

```ts
export class EcrCatalogProvider {
  constructor(options: { region: string; accessKeyId?: string; secretAccessKey?: string; roleArn?: string; createClient?: ... });

  async listRepositoriesPage(nextToken?: string): Promise<RegistryListResult>;
  // DescribeRepositoriesCommand({ nextToken }) → repositories[].repositoryName → items
  // response.nextToken → nextCursor

  async listTagsPage(repository: string, nextToken?: string): Promise<RegistryListResult>;
  // ListImagesCommand({ repositoryName, nextToken }) → imageDetails[].imageTag (lọc null) → items
  // response.nextToken → nextCursor
}
```

- Cùng cơ chế credential resolution như `EcrAuthProvider` (dùng chung 1 helper `resolveEcrClientConfig` hoặc 1 module `ecr-client.ts` nhỏ).
- Trả về đúng shape `RegistryListResult` để `filteredPage`/`collectAll` trong `RegistryClient` hoạt động không đổi.

### 3.7 `src/server/services/registry-client.ts`

1. **`authorizationHeader()` → async**:
   ```ts
   private async authorizationHeader(): Promise<string | undefined> {
     if (this.settings.credentialMode === 'ecr') {
       return this.ecrAuth.getAuthorizationHeader();
     }
     // logic basic/bearer hiện tại (sync)
   }
   ```
2. **`requestUrl()`** (line ~335): `await this.authorizationHeader()`; thêm nhánh 401 cho ECR:
   ```ts
   if (response.status === 401 && this.settings.credentialMode === 'ecr') {
     await this.ecrAuth.forceRefresh();
     const refreshed = await this.authorizationHeader();
     if (refreshed) return this.send(url, method, { ...headers, authorization: refreshed }, 0, body);
   }
   ```
   (giữ nguyên flow Bearer challenge cho các mode khác)
3. **`requestStreaming()`** (line ~361): tương tự — await header + 401 force-refresh retry.
4. **`health()`** (line ~382): `await this.authorizationHeader()`; bọc lỗi AWS thành `RegistryRequestError` với message rõ ràng (ví dụ IAM thiếu quyền).
5. **`listRepositoriesPage()`** (line ~409): nếu `credentialMode === 'ecr'` → `return this.ecrCatalog.listRepositoriesPage(last)` (last = nextToken).
6. **`listTagsPage()`** (line ~426): nếu `credentialMode === 'ecr'` → `return this.ecrCatalog.listTagsPage(repository, last)`.
7. **Constructor**: nhận thêm optional `providers?: { ecrAuth?: EcrAuthProvider; ecrCatalog?: EcrCatalogProvider }` (DI cho test). Nếu không truyền và `credentialMode === 'ecr'` → tự tạo với default `createClient` (dynamic require).

### 3.8 `src/client-v2/pages/RegistrySettingsPage.tsx`

1. **Form values type**: thêm `awsRegion`, `awsRoleArn`, `awsAccessKeyId`, `awsSecretAccessKey`, `clearAwsAccessKeyId`, `clearAwsSecretAccessKey`.
2. **Credential mode Select**: thêm option `{ value: 'ecr', label: t('AWS ECR') }`.
3. **Conditional rendering** (thay cho render-tất-cả hiện tại):
   - `anonymous` → không render field auth nào.
   - `basic` → Username + Password (+ clear checkbox).
   - `bearer` → Bearer token (+ clear checkbox).
   - `ecr` → block ECR:
     - `Alert type="info"`: "Running on EC2 with an IAM role? Leave credentials blank — the plugin uses the instance role automatically."
     - `Alert type="info"` (secondary): "ECR tokens expire after 12 hours and are rotated automatically."
     - `awsRegion` — `Input`, required, placeholder `ap-southeast-1`.
     - `awsRoleArn` — `Input`, optional, placeholder `arn:aws:iam::123456789012:role/...`.
     - `awsAccessKeyId` — `Input.Password`, optional, extra "Leave blank to use the EC2 instance role", clear checkbox khi `settings?.hasAwsAccessKeyId`.
     - `awsSecretAccessKey` — `Input.Password`, optional, clear checkbox khi `settings?.hasAwsSecretAccessKey`.
4. **After save reset**: thêm `awsAccessKeyId`, `awsSecretAccessKey`, `clearAwsAccessKeyId`, `clearAwsSecretAccessKey` vào `form.resetFields([...])`.
5. **Test connection**: không đổi code — `testConnectionDraft` gửi toàn bộ form values; server validate + gọi `GetAuthorizationToken` (qua `health()` → `authorizationHeader()`).

### 3.9 `src/locale/en-US.json`, `vi-VN.json`, `zh-CN.json`

Keys mới (cả 3 locale):

```
"AWS ECR"
"AWS Region"
"Please enter the AWS region"
"AWS Role ARN (optional)"
"AWS Access Key ID (optional)"
"AWS Secret Access Key (optional)"
"An Access Key ID is already stored. Leave this field blank to keep it."
"A Secret Access Key is already stored. Leave this field blank to keep it."
"Clear stored Access Key ID"
"Clear stored Secret Access Key"
"Running on EC2 with an IAM role? Leave credentials blank — the plugin uses the instance role automatically."
"ECR tokens expire after 12 hours and are rotated automatically."
"AWS region is required for ECR registries"
"Enter a valid IAM role ARN"
```

## 4. Test plan (unit test + mock)

### 4.1 `src/server/services/__tests__/ecr-auth.test.ts` (MỚI)

Mock AWS SDK bằng DI `createClient` (không cần `vi.mock` package):

```ts
function mockClient(handler: (command: unknown) => Promise<unknown>) {
  return () => ({ send: vi.fn(handler) });
}
```

| # | Test case | Assert |
|---|---|---|
| 1 | `getAuthorizationHeader` trả `Basic <authorizationToken>` | header đúng, dùng token base64 trực tiếp |
| 2 | Cache token — gọi lần 2 không gọi lại `send` | `send` gọi 1 lần |
| 3 | Refresh khi token trong buffer 30 phút | `send` gọi lại, token mới |
| 4 | Single-flight — 5 concurrent calls | `send` chỉ gọi 1 lần |
| 5 | `forceRefresh` invalidate cache | `send` gọi lại, header mới |
| 6 | Static creds → `createClient` nhận `credentials` | config.credentials = { accessKeyId, secretAccessKey } |
| 7 | Không creds → `createClient` không nhận `credentials` | config.credentials undefined (default chain) |
| 8 | `roleArn` → dùng STS AssumeRole (mock `@aws-sdk/nested-clients` qua `vi.mock`) | AssumeRoleCommand được gọi, token từ role creds |
| 9 | Thiếu `@aws-sdk/client-ecr` → lỗi mô tả rõ | throws Error chứa "required" |
| 10 | `expiresAt` thiếu → fallback TTL 12h | cache vẫn hoạt động |

### 4.2 `src/server/services/__tests__/ecr-catalog.test.ts` (MỚI)

| # | Test case | Assert |
|---|---|---|
| 1 | `listRepositoriesPage` map `DescribeRepositories` | items = repositoryName[], nextCursor = nextToken |
| 2 | Pagination — không có nextToken | nextCursor undefined |
| 3 | `listTagsPage` map `ListImages`, lọc `imageTag: null` | items chỉ chứa tag hợp lệ |
| 4 | `listTagsPage` pagination | nextCursor = nextToken |

### 4.3 `src/server/services/__tests__/registry-client-ecr.test.ts` (MỚI)

Dùng mock HTTP server (pattern `registry-client.test.ts`) + inject mock `EcrAuthProvider`/`EcrCatalogProvider` qua constructor:

| # | Test case | Assert |
|---|---|---|
| 1 | `health()` gửi `Authorization: Basic` từ ECR auth | mock server assert header |
| 2 | 401 → `forceRefresh()` được gọi → retry thành công | server trả 401 lần 1, 200 lần 2 |
| 3 | `listRepositories` delegate sang `EcrCatalogProvider`, không gọi `_catalog` | mock catalog trả items; server không nhận request `_catalog` |
| 4 | `listTags` vẫn dùng V2 `tags/list` | server nhận request tags/list |
| 5 | Mode không phải `ecr` vẫn dùng `_catalog` | regression check |

### 4.4 `src/server/services/__tests__/settings-ecr.test.ts` (MỚI)

Mock `ctx` (db repository + aesEncryptor) theo pattern test hiện có:

| # | Test case | Assert |
|---|---|---|
| 1 | `mergeSettings` chấp nhận `credentialMode='ecr'` | không throw |
| 2 | `ecr` + thiếu `awsRegion` → throw | `RegistryConfigurationError` |
| 3 | `awsRegion` được trim | giá trị trim |
| 4 | `awsRoleArn` sai format → throw | `RegistryConfigurationError` |
| 5 | `safeSettings` expose `hasAwsAccessKeyId`/`hasAwsSecretAccessKey` | boolean đúng |
| 6 | `getRegistryConnection` decrypt AWS secrets | giá trị decrypt |
| 7 | `updateRegistrySettings` encrypt AWS secrets + clear flag | ciphertext được lưu / xóa |

### 4.5 `src/server/__tests__/smoke.test.ts` (CẬP NHẬT)

- Thêm case: `updateSettings` với `{ credentialMode: 'ecr', awsRegion: 'ap-southeast-1' }` → 200, response chứa `awsRegion`.

## 5. Task breakdown (thứ tự thực hiện)

| # | Task | File(s) | Phụ thuộc |
|---|---|---|---|
| T1 | Thêm AWS SDK devDependencies | `package.json` | — |
| T2 | Mở rộng shared types | `src/shared/types.ts` | T1 |
| T3 | Thêm field collection | `src/server/collections/docker-registry-settings.ts` | T2 |
| T4 | Cập nhật settings service (defaults, validation, encryption) | `src/server/services/settings.ts` | T2, T3 |
| T5 | Viết `settings-ecr.test.ts` | `src/server/services/__tests__/settings-ecr.test.ts` | T4 |
| T6 | Tạo `ecr-auth.ts` (token rotation + credential resolution) | `src/server/services/ecr-auth.ts` | T2, T4 |
| T7 | Viết `ecr-auth.test.ts` | `src/server/services/__tests__/ecr-auth.test.ts` | T6 |
| T8 | Tạo `ecr-catalog.ts` | `src/server/services/ecr-catalog.ts` | T6 (dùng chung helper) |
| T9 | Viết `ecr-catalog.test.ts` | `src/server/services/__tests__/ecr-catalog.test.ts` | T8 |
| T10 | Tích hợp RegistryClient (async auth, 401 retry, catalog delegation, DI) | `src/server/services/registry-client.ts` | T6, T8 |
| T11 | Viết `registry-client-ecr.test.ts` | `src/server/services/__tests__/registry-client-ecr.test.ts` | T10 |
| T12 | UI Settings page (ECR form + conditional rendering) | `src/client-v2/pages/RegistrySettingsPage.tsx` | T2 |
| T13 | i18n keys (3 locale) | `src/locale/en-US.json`, `vi-VN.json`, `zh-CN.json` | T12 |
| T14 | Cập nhật smoke test | `src/server/__tests__/smoke.test.ts` | T4 |
| T15 | Chạy toàn bộ test + eslint + build | — | T1–T14 |

## 6. Verification

```bash
# Test từng file (tuần tự, không chạy song song server tests)
yarn test packages/plugins/plugin-docker-registry-ui/src/server/services/__tests__/ecr-auth.test.ts
yarn test packages/plugins/plugin-docker-registry-ui/src/server/services/__tests__/ecr-catalog.test.ts
yarn test packages/plugins/plugin-docker-registry-ui/src/server/services/__tests__/registry-client-ecr.test.ts
yarn test packages/plugins/plugin-docker-registry-ui/src/server/services/__tests__/settings-ecr.test.ts
yarn test packages/plugins/plugin-docker-registry-ui/src/server/__tests__/smoke.test.ts

# Lint + build
yarn eslint --fix packages/plugins/plugin-docker-registry-ui/src
yarn nocobase build plugin-docker-registry-ui --no-dts   # (PowerShell nếu bash fail)
```

## 7. Edge cases & lưu ý

1. **401 retry chỉ 1 lần** — tránh loop khi token thật sự sai (IAM revoked).
2. **`public.ecr.aws`** — pull anonymous, push cần token; mode `ecr` vẫn hoạt động cho cả hai.
3. **China regions** — host pattern `.amazonaws.com.cn`; region validation không giới hạn format.
4. **Draft test connection** — `getRegistryConnection(ctx, overrides)` đã hỗ trợ override `awsRegion`/`awsAccessKeyId`/... qua `mergeSettings`; không cần đổi resource layer.
5. **Không đổi delete flow** — ECR hỗ trợ `DELETE /v2/.../manifests/{digest}`; `BatchDeleteImage` ghi nhận là enhancement tương lai.
6. **`authorizationHeader()` async** — kiểm tra lại mọi caller; hiện tại tất cả đều async context.
7. **Không lưu token ECR vào DB** — token 12h chỉ nằm trong memory cache; DB chỉ lưu config (region, optional creds).
8. **Lỗi IAM rõ ràng** — bọc lỗi AWS SDK thành `RegistryRequestError` để UI hiển thị message hữu ích (ví dụ "AccessDenied: not authorized to perform ecr:GetAuthorizationToken").