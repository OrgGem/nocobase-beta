# Build Guide Workflow validation receipt

Kiểm thử source: 2026-11-11; build/package sau khi chốt phiên bản: 2026-11-12. Phạm vi: source hai plugin Build Guide; không sửa `packages/core/**` hoặc `packages/plugins/@nocobase*/**`. Không cài plugin, enable, nâng cấp database, chạy browser hoặc deploy.

## Kiểm thử

Các suite server được chạy tuần tự.

| Nhóm | Kết quả | Cơ sở dữ liệu / ghi chú |
| --- | --- | --- |
| Build Guide `content-acl.test.ts` | 6/6 passed | SQLite từ `.env.test` |
| Build Guide `tool-acl.test.ts` | 10/10 passed | SQLite từ `.env.test` |
| Build Guide v1/v2 manager và adapter client tests | 7 passed | Vitest; kết quả từ UI worker |
| `plugin-workflow-build-guide/src/server/__tests__/native-workflow.integration.test.ts` | 10/10 passed; 12.67 s test body | SQLite; chạy tuần tự qua `yarn test` |
| Cùng native integration file | 10/10 passed; 15.68 s test body | PostgreSQL 13 trong container riêng, chỉ bind `127.0.0.1:63517`; container `codex-build-guide-pg-20261111`, test DB prefix `guidebuild20261111` |

Integration PostgreSQL được chạy qua NocoBase test runner, với `DB_DIALECT=postgres`, `DB_HOST=127.0.0.1`, `DB_PORT=63517`, `DB_DATABASE=postgres`, `DB_USER=postgres`, `DB_TEST_PREFIX=guidebuild20261111` và `DB_TEST_DISTRIBUTOR_PORT=23450`:

```powershell
yarn test packages/plugins/plugin-workflow-build-guide/src/server/__tests__/native-workflow.integration.test.ts --run --reporter=dot
```

Fixture tạo execution/workflow/job thật và dùng provider xác định trong test; test không gọi provider bên ngoài. `workflow:process` chạy qua queue/worker trong tiến trình app của fixture `getApp`; chưa chạy worker ở tiến trình riêng. Hai ca mới được đo riêng: cancel khi provider đang chờ trả về hoàn tất trong 1.689 s (assertion giới hạn dưới 5 s), còn cancel run `unknown` với Space owner đã thay thế hoàn tất trong 1.715 s. Container và anonymous volume riêng đã được dừng, xóa và xác nhận không còn; các dịch vụ/container khác không bị đụng tới. Lệnh thử trước khi sửa cancel chờ 61.652 s ở ca này do nested execution-lock acquisition; sau sửa không còn thời gian chờ đó.

Mười ca native gồm build hai chương và publish, provider lỗi rồi retry execution mới, reconcile checkpoint Prepare sau khi mất tín hiệu resume, chống resume trùng ở Prepare/Plan/chapter, cancel khi provider đang chạy và fence kết quả muộn, xử lý cancel run `unknown` mà không thay Space owner mới, đọc execution/job theo quyền Space, và chặn sửa workflow được quản lý.

## Kiểm tra mã nguồn

- ESLint `--fix` chạy trên các file source/test đã sửa trong hai plugin và client shims; lệnh cho `build.ts` được chạy thêm với `--no-ignore`.
- TypeScript Compiler API chẩn đoán có phạm vi: **0 diagnostics trên 21 server roots** của hai plugin. Đây không phải full monorepo typecheck.
- Full monorepo typecheck chưa hoàn tất: TypeScript 5.1.3 dừng ở lỗi parse TS1005 trong dependency `@types/sanitize-html`, trước khi đánh giá toàn bộ plugin. Scoped Compiler API check là bằng chứng typecheck áp dụng ở đây.
- Không chạy full monorepo test suite.

## Build artifacts

Hai lệnh sau chạy từ repository root bằng PowerShell, đều exit 0:

```powershell
yarn nocobase build plugin-build-guide-block --no-dts
yarn nocobase build plugin-workflow-build-guide --no-dts
```

Mỗi `dist` có bundle client v1/v2, server, `externalVersion.js` và locale `en-US`, `zh-CN`, `vi-VN`. Một số kích thước đầu ra được ghi lại để nhận diện build này:

| Plugin | Client v1 | Client v2 | Server | `externalVersion.js` |
| --- | ---: | ---: | ---: | ---: |
| `plugin-build-guide-block` | 114,138 B | 84,327 B | 2,047 B | 884 B |
| `plugin-workflow-build-guide` | 13,112 B | 13,014 B | 2,356 B | 679 B |

## Package archives

`npm pack` chỉ chạy sau khi cả hai build thành công. Cả hai archive chứa bundle v1/v2, server, locale và `externalVersion.js`.

| Archive | Kích thước | SHA-256 |
| --- | ---: | --- |
| `plugin-build-guide-block/plugin-build-guide-block-1.1.14.tgz` | 1,082,857 B | `F9A3EF50E84FA620AB896A6D781E4DF5066DA2BDEEDD8D4A09783104DEF865C4` |
| `plugin-workflow-build-guide/plugin-workflow-build-guide-0.1.0.tgz` | 57,602 B | `9306588414C5F85FD5BD80C7CADE763FC55C5AB85D1F16681B0E6762BA3C5FA9` |

`plugin-build-guide-block@1.1.13` already has a published npm version and immutable Git tag. The workflow source therefore ships as `1.1.14`; the adapter peer range is `^1.1.14`. Local archives are validation artifacts only; GitHub Actions creates release tags and publishes from the pushed `main` commit.

Archive được kiểm tra thành viên mong đợi và package runtime; không tìm thấy đường dẫn workspace hoặc dữ liệu credential trong bundle phát hành. Các archive là artifact local, chưa được publish.

## Giới hạn

Không có browser/E2E, kiểm thử role thực trên instance đã cài, DB upgrade, worker process tách riêng, provider thật, triển khai hay cutover. SQLite và PostgreSQL test đều dùng provider stub. Cần chạy kiểm chứng staging riêng cho worker deployment thực tế và quy trình operator trước khi cutover.
