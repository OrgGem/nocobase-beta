# Skill Registry Hub: kế hoạch public, list và download skill

## 1. Mục tiêu

Skill Hub hiện là registry nội bộ của một instance: `skillDefinitions` chứa cả metadata
và source (`codeTemplate`, `storageUrl`, `fileId`), còn plugin-ai lấy các row `enabled`
để tạo dynamic tool. Mô hình này chưa đủ cho public registry vì:

1. row runtime có thể bị sửa tại chỗ, nên client không biết chính xác version đã tải;
2. API list/get nội bộ chứa field private và không nên trở thành public catalog;
3. download hiện là file output của execution, chưa phải artifact bất biến của skill;
4. Agent cần tên tool ổn định dù skill đổi tên hoặc nâng version.

Registry Hub phải tách ba lớp: **catalog public**, **artifact bất biến**, và **Agent binding**.
Public catalog chỉ trả manifest/metadata. Source chỉ đi qua download có digest/chữ ký.
Agent chỉ thấy và chạy skill đã được cài, enable và bind.

## 2. Data model đề xuất

### `skillRegistryPackages` — public identity

Identity bất biến là `publisherSlug/packageSlug`, không phải `skillDefinitions.name`.

| Field | Mục đích |
|---|---|
| `publisherId`, `publisherSlug`, `slug` | owner + namespace public |
| `displayName`, `description`, `iconUrl`, `license`, `tags` | metadata catalog |
| `visibility` | `public` hoặc `private` |
| `status` | `draft`, `pending_review`, `published`, `suspended` |
| `defaultChannel` | `stable`, `beta`, `nightly` |
| `latestStableVersionId` | cache để list nhanh |
| `publishedAt`, `createdAt`, `updatedAt` | audit |

Unique constraint: `(publisherSlug, slug)`.

### `skillRegistryVersions` — version immutable

Mỗi lần publish tạo row mới. Sau khi `published`, không cho update nội dung; chỉ cho yank.

| Field | Mục đích |
|---|---|
| `packageId`, `version`, `channel` | SemVer + release channel |
| `manifestJson`, `runtime`, `entrypoint` | contract chạy |
| `inputSchema`, `outputSchema` | JSON Schema đã validate |
| `permissions` | capability: network/filesystem/attachments... |
| `dependencies`, `compatibility` | package và NocoBase/plugin-ai/runtime ranges |
| `artifactId`, `artifactDigest` | artifact + SHA-256 |
| `publisherSignature`, `registrySignature` | chữ ký Ed25519 |
| `status` | `pending_scan`, `pending_review`, `published`, `rejected`, `yanked` |
| `yankedAt`, `yankReason`, `changelog` | rollback và client display |

Unique constraint: `(packageId, version)`. Không được upload bytes khác cho cùng version.

### `skillRegistryArtifacts` — object storage immutable

Lưu `storageKey`, `sizeBytes`, `contentType`, `artifactDigest`, `manifestDigest`, `sbomJson`.
Storage key chứa digest, ví dụ `skill-registry/sha256/ab/cd/<digest>.tar.zst`; không dùng
tên file do user gửi làm key.

### `skillRegistryInstallations` — trạng thái của client

Lưu package/version/channel, `installedBy`, `status`, digest/signature đã verify,
`updatePolicy` (`pinned` hoặc `channel`), timestamps và `lastError`. Client nhờ đó biết
package đã download nhưng verify fail, hay đã cài nhưng smoke test fail.

### Liên kết runtime hiện có

Thêm nullable fields vào `skillDefinitions`:

```text
registryPackageId, registryVersionId, registryChannel,
sourceDigest, sourceSignature, installId, updatePolicy
```

`skillDefinitions` là execution projection để giữ compatibility. Registry version mới là
source of truth. Upgrade chỉ đổi projection sau verify và giữ nguyên `toolName`:

```text
acme/pdf-report@1.0.0 -> skill_hub_pdf_report
acme/pdf-report@1.1.0 -> skill_hub_pdf_report
```

Agent binding tham chiếu package/version hoặc channel; runtime vẫn re-check binding bằng
`SkillAccessService` ngay trước khi queue execution.

## 3. Publish flow: từng bước và hệ quả

1. Publisher upload `manifest.json` + artifact archive vào staging.
2. Server validate namespace, slug, SemVer, JSON Schema, entrypoint, size, dependency policy,
   path traversal, symlink escape và zip bomb. Sai thì trả `422`, chưa public version.
3. Worker giải nén vào thư mục tạm, chạy `CodeValidator`, package scan và smoke test với
   `testInput`. Fail thì version ở `rejected` hoặc `pending_review`, không download public.
4. Server tính SHA-256 trên đúng bytes artifact, tạo SBOM và ký registry envelope. Client
   nhờ đó phát hiện artifact bị thay giữa lúc publish và download.
5. Moderator approve (nếu policy yêu cầu), rồi transaction chuyển version sang `published`
   và phát event `skill.registry.published` để invalidate catalog cache.
6. Version đã publish không sửa được. Sự cố dùng `yank`, rồi publish version vá mới.

Publish API mẫu:

```http
POST /api/skillRegistry:publish
Authorization: Bearer <publisher-token>
Content-Type: multipart/form-data

manifest={"slug":"pdf-report","version":"1.1.0","channel":"stable",...}
artifact=@pdf-report-1.1.0.tar.zst
```

## 4. Public list/detail/download API

Không expose trực tiếp `skillDefinitions:list`; resource đó là runtime table có source.
Tạo resource riêng `skillRegistry`.

### `GET /api/skillRegistry:packages`

Anonymous chỉ đọc package `visibility=public,status=published`.

Query: `q`, `publisher`, `tag`, `runtime`, `channel`, `compatibleWith`, `cursor`, `limit`
(tối đa 100), `sort=downloads|updated|rating`.

```json
{
  "data": [{
    "publisher": "acme",
    "slug": "pdf-report",
    "displayName": "PDF Report",
    "latest": {"version": "1.1.0", "channel": "stable"},
    "runtime": "python",
    "tags": ["pdf", "report"],
    "compatibility": {"nocobase": ">=2.0.0"},
    "artifactDigest": "sha256:...",
    "downloads": 1820
  }],
  "nextCursor": "..."
}
```

Hỗ trợ `ETag`/`If-None-Match`; response public không chứa `codeTemplate`, private
`instructions`, `storageKey`, `storageUrl` hoặc `fileId`.

### `GET /api/skillRegistry:package`

Trả detail, changelog, permissions và danh sách version published. Private/draft/yanked
chỉ hiện với owner/moderator theo ACL.

### `GET /api/skillRegistry:download`

Input: `package`, `version` hoặc `channel`. Chỉ resolve version `published`, chưa yank.
Server trả `302` đến signed object URL TTL 5 phút, hoặc stream khi storage không hỗ trợ.
Headers: `Digest`, `ETag`, `Content-Disposition`.

Ghi audit bất đồng bộ vào `skillRegistryDownloads`: package/version, client/user id,
IP/user-agent đã hash, kết quả và bytes. Không log token của signed URL.

## 5. Client install và Agent binding

1. Client list catalog, mở detail và xem version/changelog/capability.
2. User bấm Install; artifact được tải vào file tạm.
3. Client/server verify digest + publisher/registry signature trước khi giải nén. Sai thì xóa
   file tạm và ghi `verification_failed`.
4. `skillRegistry:install` kiểm tra compatibility và tenant policy, rồi tạo installation.
5. Server materialize vào `skillDefinitions` với `enabled=false`.
6. Worker chạy smoke test trong sandbox. Pass mới cho enable/bind Agent.
7. Dynamic tool dùng stable `toolName`; public package không tự động cấp quyền cho mọi Agent.
8. Update `pinned` chỉ khi user chọn version; update `channel` chọn bản tương thích mới nhất.
   Nếu verify/smoke test fail, giữ bản cũ và ghi `lastError`.

Runtime flow:

```text
Agent tool call
  -> stable toolName
  -> SkillAccessService (employee binding)
  -> installed registryVersionId + digest
  -> sandbox worker
  -> skillExecution + execution span
```

## 6. Security và ACL bắt buộc

- Public artifact là untrusted code: không chạy trong API process, chỉ worker sandbox.
- Public manifest v1 phải đọc input từ `SKILL_INPUT_FILE`/`input.json`; publisher artifact
  không được dùng raw `{{field}}` interpolation. Chỉ placeholder server-owned như
  `{{inputFile}}`, `{{outputDir}}`, `{{skillDir}}` được phép trong compatibility adapter.
- Network mặc định deny; capability phải được cả manifest và tenant policy cho phép.
- Chặn archive traversal, absolute path, symlink, zip bomb, native addon ngoài allowlist,
  dependency typosquat và archive quá quota.
- Verify digest/signature trước materialize; yanked version không được cài mới hoặc queue.
- Rate limit list/download/publish và quota theo publisher/client.
- Private package download cần owner/tenant ACL; public download không biến API thành
  arbitrary-file proxy.

| Action | Anonymous | Logged-in | Publisher/Moderator |
|---|---:|---:|---:|
| list/detail public | read | read | read |
| download public version | read | read | read |
| publish | deny | publisher only | allow |
| review/yank | deny | deny | moderator |
| install | deny | tenant policy | admin/policy |

## 7. Migration từ Skill Hub hiện tại

1. Backfill stable `toolName` trước khi bật Registry path.
2. Skill local/plugin cũ trở thành pseudo package `local/<name>@0.0.0-local`, giữ nguyên
   `skillDefinitions.id` và `toolName`.
3. Skill import từ Git ghi `sourceRepo/sourceCommit`; Git URL không phải immutable artifact.
4. Không auto-public dữ liệu cũ: default `visibility=private`; owner chọn license/version.
5. Backfill package/version theo batch và checksum. Row không xác minh được đánh dấu
   `legacy_unverified`, yêu cầu re-publish.
6. MCP chấp nhận tên legacy trong một release; registry identity/toolName mới là canonical.

## 8. Phases và acceptance criteria

### Phase 0 — Contract/security (1 sprint)

- Chốt manifest v1, SemVer/channel, capability enum, signature envelope và threat model.
- Acceptance: manifest errors có code ổn định; catalog contract không có source field.

### Phase 1 — Registry read path (1 sprint)

- Collections/indexes/migrations; public list/detail/download metadata; cursor, ETag, signed
  URL và audit.
- Acceptance: anonymous list được published public; draft/private/yanked không xuất hiện;
  digest và ETag ổn định giữa các request không đổi dữ liệu.

### Phase 2 — Publish pipeline (1–2 sprint)

- Staging, validation, archive/code/dependency scan, smoke test, digest, SBOM, Ed25519,
  moderation và immutable transition.
- Acceptance: upload lại cùng version trả `409`; bytes bị đổi làm verify fail; yank chặn
  install mới.

### Phase 3 — Client catalog/install (1 sprint)

- Search/filter/detail/version/changelog; ETag cache; progress/retry; verify; install state.
- Acceptance: list -> download -> verify -> install chạy end-to-end; checksum sai không để
  lại file hoặc row enabled.

### Phase 4 — Agent adapter/binding (1 sprint)

- Materialize registry version; registry fields; stable tool mapping; Agent bind theo
  version/channel; upgrade/rollback.
- Acceptance: upgrade không đổi `toolName`; Agent A không dùng skill chỉ bind cho Agent B;
  unbind có hiệu lực trước queue; execution lưu exact version + digest.

### Phase 5 — Governance/scale (1 sprint)

- Publisher profile, moderation, advisory, analytics, CDN/cache và artifact lifecycle.
- Acceptance: audit trả lời được ai publish, ai download, Agent nào chạy version/digest nào;
  p95 list/download đạt SLO được chốt ở Phase 0.

## 9. Test matrix tối thiểu

- Unit: slug/SemVer, manifest schema, canonical digest/signature, channel resolution,
  traversal/symlink/zip bomb.
- Server integration: public/private ACL, cursor + ETag, signed URL expiry, immutable version,
  duplicate `409`, yank, counter/audit.
- Client E2E: anonymous list, detail, progress/retry, signature failure, install, upgrade,
  rollback.
- Agent E2E: tool chỉ xuất hiện sau install+enable, deny khi thiếu binding, stable toolName,
  execution lưu registry version/digest và native Sub-Agent link đúng tool span.
