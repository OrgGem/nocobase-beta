# Trạng thái sửa lỗi custom plugins

> **Cập nhật 2026-11-06:** snapshot này được đưa vào đợt commit/push theo yêu cầu. Xem [review vòng 2](custom-plugins-review-round2.md) để biết 5 finding mới còn OPEN, coverage 59 plugin và kiểm chứng trước commit. Các trạng thái working tree/build/test bên dưới mô tả thời điểm của lượt cũ.

> **Cập nhật 2026-11-05:** đã sửa thêm 9 finding FR-01–FR-09 trong 6 plugin. Xem [kết quả sửa tiếp theo](custom-plugins-followup-fix-status.md), gồm regression, migration, build/pack và giới hạn xác nhận. Phần dưới giữ bằng chứng của lượt IR ngày 2026-11-04.

Ngày: 2026-11-04. Repository `OrgGem/nocobase-beta`, nhánh `main`, baseline `070854510da07be27c0ebb1e06aa7dad43fa4efc`, NocoBase `2.2.37`.

Lượt này xử lý **17 finding IR-01–IR-17 của [review độc lập](custom-plugins-independent-review.md)**, sửa source của **20 custom plugin**. Các thay đổi đang ở working tree. Bảng dưới ghi bằng chứng ở mức source, regression và HTTP fixture; build/pack không đồng nghĩa đã cài artifact hoặc chạy dịch vụ bên ngoài thành công.

## Kết quả theo plugin

Tên plugin trong bảng có tiền tố `plugin-`. Test được dẫn tương đối từ thư mục plugin tương ứng trong `packages/plugins/`.

| Plugin | Finding | Thay đổi đã thực hiện | Kiểm chứng liên quan |
| --- | --- | --- | --- |
| `oidc-auth` | IR-01, IR-14 | Thực thi `requireVerifiedEmail`; luôn đòi `email_verified === true` khi bind vào email của user có sẵn. Giữ login bằng identity đã liên kết. Đăng ký toàn bộ `options` trong form v2 để không mất các nhánh không hiển thị khi host merge nông. | `src/server/__tests__/oidc.test.ts`, `security.test.ts`; `src/client-v2/__tests__/settings.test.tsx` |
| `block-cross-join` | IR-02, IR-12 | Giải ACL `list` cho từng datasource/collection; áp row filter, field/except và kiểm tra cột join/sort/filter trước đọc. Đăng ký pre-action riêng cho schema join. Trả `{rows, count, page, pageSize}` để core tạo đúng envelope cho client. | `src/server/__tests__/query.test.ts`; `query-integration.test.ts`: HTTP với role thường, row scope, field scope, collection bị cấm và response envelope |
| `database-plus-manager` | IR-03 | Interceptor cursor dùng đúng repository/resource đã được ACL duyệt; bỏ qua association resource. Standalone cursor tự giải ACL của collection được yêu cầu và dùng datasource hiện tại. Bỏ đăng ký migration rỗng không đúng contract. | `src/server/__tests__/cursor-acl.test.ts`, `cursor-integration.test.ts`, cùng các test filter/cursor hiện có |
| `microsoft-graph-gateway` | IR-04 | Bỏ `loggedIn` cho các thao tác quản trị; giữ snippet admin và đường API bên ngoài có kiểm tra API key/scope riêng. | `src/server/__tests__/admin-acl.test.ts`, security/audit tests; middleware ACL thật với member và admin |
| `file-preview-auth` | IR-05, IR-08 | Bỏ quyền generic get/list/create/update OCR result cho mọi user đăng nhập. Nhánh file không có parent phải truy vấn đúng ID dưới filter `view` đã resolve. | `src/server/__tests__/ocr-acl.test.ts`, `attachment-scope.test.ts`, `smoke.test.ts` |
| `ai-browser` | IR-06 | Generic list/get áp owner scope cho profile/session/cache và scope qua session cho task/event; bỏ association expansion, cookie và localStorage với non-admin. Khi tạo phiên, profile phải thuộc owner và đang enabled. | `src/server/__tests__/read-scope.test.ts`, `read-integration.test.ts`, `profile-scope.test.ts`; HTTP với hai owner và driver giả cho creation |
| `package-registry` | IR-07 | Kiểm tra `authRequired` trước metadata, tarball hoặc proxy cache lookup. Router chạy trước resourcer nên gọi authenticator NocoBase với action context riêng. Public registry giữ khả năng đọc anonymous. | `src/server/__tests__/registry-auth.test.ts`, `registry-integration.test.ts`; HTTP private/public với anonymous, token hợp lệ và token lỗi |
| `s3-private-storage` | IR-08 | Fallback không có parent chỉ cho phép khi repository tìm thấy đúng file dưới data scope `view`; thiếu context thì từ chối. | `src/server/__tests__/attachment-scope.test.ts`, `acl-integration.test.ts`, các test adapter/ACL hiện có |
| `sftp-private-storage` | IR-08 | Áp cùng kiểm tra ID file và data scope ở fallback. Cập nhật fixture encryption để tách rõ fallback `APP_KEY` và ephemeral key. | `src/server/__tests__/attachment-scope.test.ts`, `secret-hooks.test.ts`, `encrypt-migration.test.ts` và các test server hiện có |
| `ai-drawio` | IR-09 | Bổ sung module system prompt từ sáu tool thực sự đăng ký và trỏ import đến module đó. | `src/server/__tests__/system-prompt.test.ts`; load server entry và gọi endpoint prompt; native build |
| `data-cloner` | IR-10, IR-11 | Dùng placeholder `$1` phù hợp Sequelize `bind` cho bốn dialect; giữ checkpoint 0. Task kết thúc `error` khi table/worker lỗi, có thể retry table lỗi; giữ trạng thái pause và xóa thông báo lỗi khi thành công. | `src/server/__tests__/clone-engine.test.ts`: nhiều chunk, resume, bind formatting của Sequelize, fail/retry/pause và worker rejection |
| `file-search` | IR-13 | Định nghĩa resource `fileSearch` sau khi đăng ký action handlers, đúng thời điểm ResourceManager lấy handler. Bỏ khai báo `db` che accessor kế thừa. | `src/server/__tests__/plugin-load.test.ts`, `settings.test.ts`; ResourceManager thật kiểm tra action đã resolve |
| `carbone-template-manager` | IR-15 | Snippet `.settings` chứa hợp các action của snippet con, thay vì chứa tên snippet không được ACL tự mở rộng. | `src/server/__tests__/settings-acl.test.ts` với ACL thật; smoke hiện có |
| `data-source-mssql` | IR-16 | Đăng ký `DeleteCollection` và `allowCollectionDeletion` trong v2; hỗ trợ xóa một/nhiều collection, xác nhận cascade, reload và xử lý lỗi. | `src/client-v2/__tests__/delete.test.tsx`, `form.test.tsx`; component test kiểm tra request scoped theo datasource và đường 403 |
| `data-source-elasticsearch` | IR-16 | Bổ sung thao tác xóa collection native v2, request scoped theo datasource, xác nhận/reload/error và khóa locale en-US/zh-CN. | `src/client-v2/__tests__/delete.test.tsx`, `registration.test.ts` |
| `docker-registry-ui` | IR-17 | Đồng bộ client read/write snippet và nội dung hướng dẫn sang `pm.plugin-docker-registry-ui.*` như server. | `src/client-v2/__tests__/permissions.test.ts` và các test client hiện có |
| `skill-registry` | IR-17 | Đồng bộ prefix client với `pm.plugin-skill-registry.*`; integration fixture dùng tên plugin mặc định thực tế. | Client permission tests; `src/server/__tests__/plugin-integration.test.ts` |
| `selector-registry` | IR-17 | Đồng bộ client và API docs với `pm.plugin-selector-registry.*`; integration fixture dùng tên plugin thực tế. | `src/server/__tests__/plugin-integration.test.ts` và các test contract hiện có |
| `user-memory` | IR-17 | Sửa snippet ở cả entry v1 và v2 thành `pm.plugin-user-memory`. | `src/client/__tests__/plugin.test.tsx` |
| `idp-oidc-client-manager` | IR-17 | Sửa snippet ở cả entry v1 và v2 thành `pm.plugin-idp-oidc-client-manager`. | Client registration test hiện có; native build của cả hai lane |

### Hiệu chỉnh IR-02

Probe review cũ gọi thẳng handler, bỏ qua generic SQL `query` guard của core. HTTP fixture xác nhận guard chung chặn payload join thông thường trước handler. Vì vậy lỗi thiếu ACL trong handler có thật, nhưng mô tả “user thường khai thác ngay qua HTTP mặc định” trước đây quá mạnh. Bản sửa đồng thời cho phép đúng schema join qua pre-action riêng và áp ACL từng nguồn ngay trong handler. Không bỏ generic guard của các resource khác.

### Những lỗi test nền đã sửa

- Agent Orchestrator: bổ sung `count()` cho hai `MemoryRepository` fixture đang thiếu phương thức mà runtime sử dụng.
- Field Selection Filter: kiểm tra hành vi đăng ký của entry v2 thay vì đòi class v1 và v2 cùng identity.
- Skill Registry: mock field version/publishedAt đúng kiểu, thêm dependency fixture bị thiếu và lấy giới hạn candidate từ constant hiện hành.
- SFTP: tách môi trường `APP_KEY` trong test ephemeral encryption và cung cấp context cho migration fixture.
- API Manager: xóa file test trống; sửa assertion thông báo AES và body echo theo payload đã gửi; sửa kiểu binary response parser theo contract Superagent. Không thay source production của API Manager.

Ba plugin ngoài danh sách sửa source có thay đổi **chỉ ở test**: Agent Orchestrator, Field Selection Filter và API Manager.

## Kiểm chứng

| Phạm vi | Kết quả | Giới hạn |
| --- | --- | --- |
| Server tổng hợp, chạy tuần tự | **261/298 file được chọn đều pass; 2.072 test pass, 3 skipped** | 37 file server khác chưa chạy; không phải tất cả server integration cần dịch vụ bên ngoài |
| Client v1/v2 toàn bộ custom | Lượt đầy đủ: **96/97 file pass, 388 test pass, 1 fail**. Assertion Field Selection Filter đã sửa và chạy lại riêng **7/7 pass** | Không gọi đây là một lượt 97 file cùng pass; không browser E2E |
| HTTP + SQLite fixture mới | Cross Join, cursor pagination, private npm registry và AI Browser đều pass | AI Browser chỉ sync các collection dùng trong read regression, session service được mock; không chạy browser backend |
| ESLint | `yarn eslint --fix` trên các file TypeScript đã chạm, không còn lỗi/cảnh báo | Không lint lại toàn bộ 59 plugin; Markdown không nằm trong parser ESLint của repo |
| TypeScript tập trung | **70 file đã chạm, 0 diagnostic tại các file này** | Compiler API vẫn báo 83 diagnostic ở dependency/source khác, gồm 3 lỗi parse `@types/sanitize-html`; không phải full-project typecheck pass |
| Native build | **20/20 plugin pass** bằng PowerShell, `yarn nocobase build <package> --no-dts` | Đã kiểm tra bundle client v1/v2, server, locale và `dist/externalVersion.js`; không sinh `.d.ts` |
| npm pack thực tế | **20/20 archive đủ bundle client v1/v2, server, externalVersion và locale en-US/zh-CN** | Đã chạy lifecycle prepack, đọc danh sách file thật trong `.tgz` và lưu SHA-256; chưa clean-install artifact |

Không sửa core/base plugins, cấu hình hoặc database của ứng dụng đang chạy. SQLite cho test được cài riêng trong `%TEMP%\nocobase-custom-fix-deps`; không thay dependency/lockfile gốc. Test dùng `.env` rỗng, SQLite `:memory:` và storage tạm.

Sau lượt server tổng hợp, thay đổi cuối chỉ sửa kiểu binary parser của test API Manager và return value của hook test AI Browser. Đã chạy lại toàn bộ server tests API Manager: **22 file / 298 test pass**; AI Browser profile regression: **3/3 pass**. Đây là rerun, không cộng các test trùng vào tổng 2.072 ở trên.

## Phạm vi chưa xác nhận

- Chưa browser E2E, đăng nhập IdP thật, Graph tenant, S3/SFTP streaming, Browserless/Playwright backend, Carbone service hoặc npm upstream thật.
- Data Cloner dùng repository giả và bind formatter Sequelize thật; chưa copy dữ liệu trên PostgreSQL/MySQL/MSSQL thật. MSSQL/Elasticsearch delete được kiểm tra ở component/request contract, chưa xóa collection trên dịch vụ thật.
- Chưa cài `.tgz` vào một instance sạch hoặc kiểm tra deployment. Không suy từ build/pack thành hoạt động production.
- TypeScript 5.1.3 vẫn gặp syntax không hỗ trợ trong `@types/sanitize-html`; diagnostic ngoài phạm vi file sửa chưa được giải quyết trong lượt này.
- Tại lượt IR, full SQLite sync của fixture AI Browser gặp schema `aiBrowserConfig` có composite primary key với cột tự tăng. **FR-09 đã sửa ngày 2026-11-05**, kèm regression fresh sync và migration → sync → đọc/ghi bảng cũ; xem báo cáo tiếp theo. Chưa xác nhận clean-install artifact hoặc migration trên dialect production.
- Backlog v2 ngoài các finding IR, như feature parity, i18n rộng và tổ chức mã, vẫn theo [kế hoạch v2](custom-plugins-v2-review.md).

## Bằng chứng cục bộ và lệnh tái lập

Các log nằm trong `%TEMP%`, không phải CI artifact. Các test regression nằm trong source để chạy lại được sau phiên này.

- `custom-fix-server-final.json` và `custom-fix-server-final.log`: 261 file được chọn và kết quả server tổng hợp.
- `custom-fix-server-not-run.json`: 37 file server ngoài lượt chạy này.
- `custom-fix-client-tests.log`, `custom-fix-field-selection.log`: lượt client đầy đủ và rerun lỗi duy nhất.
- `custom-fix-http3-tests.log`, `custom-fix-ai-tests.log`: các HTTP regression bổ sung.
- `custom-fix-api-final.log`, `custom-fix-ai-profile-final.log`: test liên quan sau sửa kiểu helper cuối cùng.
- `custom-fix-eslint-final.log`, `custom-fix-typecheck.json`: lint và semantic diagnostics tập trung.
- `custom-fix-build-results.json`, `custom-fix-build-<plugin>.log`: native build.
- `nocobase-custom-fixed-packages-20261104/pack-results.json`: tên/version, kích thước, integrity, SHA-256 và danh sách bundle bắt buộc đã kiểm tra trong từng archive.

Chạy test từ repository root trong PowerShell:

```powershell
$env:TEST_ENV = 'server-side'
$env:DB_DIALECT = 'sqlite'
$env:DB_STORAGE = ':memory:'
$env:APP_ENV_PATH = "$env:TEMP\independent-custom-plugin-review\empty.env"
$env:NODE_PATH = "$env:TEMP\nocobase-custom-fix-deps\node_modules"
$env:STORAGE_PATH = "$env:TEMP\custom-plugin-fixes-storage"
yarn test packages/plugins/plugin-block-cross-join/src/server --run
yarn test packages/plugins/plugin-ai-browser/src/server --run

$env:TEST_ENV = 'client-side'
yarn test packages/plugins/plugin-data-source-mssql/src/client-v2/__tests__/delete.test.tsx --run
```

Các biến `%TEMP%` trên tham chiếu fixture cục bộ đã chuẩn bị trong phiên này. Trên máy khác cần chuẩn bị môi trường test tương đương. Không chạy các server test song song.
