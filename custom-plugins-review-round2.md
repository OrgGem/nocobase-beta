# Review vòng 2 — custom plugins

Ngày chốt: 2026-11-06. Repository `OrgGem/nocobase-beta`, nhánh `main`, baseline `070854510da07be27c0ebb1e06aa7dad43fa4efc`, NocoBase `2.2.37`.

## Kết luận

Các bản sửa **IR-01–IR-17** và **FR-01–FR-09** đã có trong snapshot giao GitHub cùng báo cáo này. Kết quả và giới hạn của từng bản sửa nằm ở [IR fix status](custom-plugins-fix-status.md) và [FR fix status](custom-plugins-followup-fix-status.md). Đây không phải kết luận toàn bộ custom plugins đã hết lỗi.

Vòng mới bao phủ inventory, điểm vào, tìm kiếm các đường truy cập nhạy cảm và bộ test hiện có của **59 custom plugin**, đồng thời kiểm tra sâu các đường ACL, AI tools, file upload và raw router được chọn từ scan. Có **5 finding mới được tái hiện trong 4 plugin: 3 P1 và 2 P2**, đều **OPEN**. Không sửa logic production của các finding mới trong vòng review này. Thay đổi hành vi duy nhất sau khi bắt đầu vòng review là cập nhật một kỳ vọng test của Agent Orchestrator để khớp core hiện tại.

## Finding mới

### RR-01 — P1 — Build Guide AI search bỏ qua ACL đọc dữ liệu

- Vị trí: `packages/plugins/plugin-build-guide-block/src/server/tools/search-guides.ts:193` và nhánh `search_pages` tại dòng 224; đăng ký tool tại `src/server/plugin.ts:72`.
- Tool được đăng ký vào `DefaultToolsManager` với `defaultPermission: ALLOW`, đọc repository trực tiếp mà không giải quyền của user gọi tool. `list_spaces` và `search_pages` không áp row/field scope.
- Tái hiện: SQLite + plugin thật + tool registry core thật; role không được `aiBuildGuidePages:get` nhận HTTP 403 từ resource bình thường, nhưng tool `search_pages` trả snippet `ROUND2_PRIVATE_GUIDE` của trang đó. Tool được gọi bằng HTTP fixture riêng để cung cấp context user thật; đây không phải kiểm tra hội thoại AI end-to-end.
- Ảnh hưởng: người được cung cấp tool có thể tìm tên/metadata/snippet của guide ngoài phạm vi đọc của mình. Không khẳng định nhánh `read_page` đọc được toàn văn: nhánh đó đang gặp RR-05.
- Hướng sửa: giải ACL list/get bằng context người gọi cho cả spaces và pages, áp row/field scope trước query và trước tạo snippet; thêm regression user bị cấm, row khác, field bị cấm, user được phép.
- Trạng thái: **OPEN**, riêng biệt với FR-04 đã sửa ở endpoint HTML/Markdown.

### RR-02 — P1 — Document Understanding đọc file local từ JSON do người gọi cung cấp

- Vị trí: `packages/plugins/plugin-document-understanding/src/server/actions.ts:107-119`.
- `request.files || request.body?.files` coi object trong JSON body như file upload do middleware tạo. Thuộc tính `path`/`filepath` được chuyển thẳng tới `existsSync` và `readFileSync`.
- Tái hiện: role chỉ được cấp `docUnderstanding:executePipeline` gửi JSON có `files.document.path` trỏ tới canary tự tạo trong TEMP. Resource thật trả 200; spy ở service nhận đúng bytes canary trong `multipartFiles`. Không đọc secret thật và không gọi dịch vụ ngoài.
- Ảnh hưởng: người có quyền chạy pipeline có thể đưa nội dung file mà process server đọc được vào pipeline, vượt phạm vi upload bình thường. Source service chuyển file tới processor đã cấu hình; việc dữ liệu được trả lại hoặc gửi ra ngoài phụ thuộc pipeline.
- Hướng sửa: chỉ nhận file từ multipart middleware đáng tin cậy, bỏ fallback JSON file path, kiểm tra cấu trúc/giới hạn file và vòng đời file tạm. Test JSON giả mạo và multipart hợp lệ qua HTTP.
- Trạng thái: **OPEN**.

### RR-03 — P1 — Shared Forms v1 bỏ qua quyền xem form và whitelist field khi submit

- Vị trí: `packages/plugins/plugin-shared-forms/src/server/plugin.ts:296-329`, `:375-394`.
- Kiểm tra `sharedForms:view`, danh sách field được thiết kế và `updateAssociationValues` chỉ nằm trong nhánh v2. Nhánh v1 đổi `sharedSubmit` thành `create`, rồi đặt `ctx.permission = { skip: true }`.
- Tái hiện: form v1 đang enabled, không giới hạn `allowedRoles`, schema chỉ có `title`; user đăng nhập không có quyền `sharedForms:view` hoặc tạo collection đích. Hai request thông thường trả 403 nhưng `sharedSubmit` với đúng form key và payload `{ title, approved: true }` trả 200; database lưu `approved=true` dù field này không có trên form.
- Điều kiện: biết form key, có tài khoản đăng nhập, form cho phép role của user hoặc không giới hạn role. Không khẳng định anonymous có thể submit.
- Hướng sửa: thực thi quyền xem theo row và derive whitelist từ legacy schema cho v1 trước khi cấp quyền create; kiểm soát association writes tương đương v2. Test cả v1 và v2 qua HTTP.
- Trạng thái: **OPEN**.

### RR-04 — P2 — File Search không đăng ký được AI tool với core hiện tại

- Vị trí: `packages/plugins/plugin-file-search/src/server/ai-tools.ts:23-66`; contract core tại `packages/core/ai/src/tools-manager/index.ts:61-81`.
- Plugin truyền wrapper `{ groupName, tool: { name, schema, invoke } }`; core cần `definition.name`, `definition.schema` và `invoke` ở cấp ngoài. Core ném TypeError, catch của plugin chỉ ghi warning rồi tiếp tục load.
- Tái hiện bằng `registerFileSearchAiTool` và `DefaultToolsManager` thật: có warning TypeError, `getTools('file_search')` trả undefined.
- Hướng sửa: chuyển sang `ToolsOptions` hiện tại và kiểm tra tool thực sự invoke được action search với context ACL của user. Giữ behavior `enableAiTool`.
- Trạng thái: **OPEN**, riêng biệt với IR-13 đã sửa định nghĩa resource HTTP.

### RR-05 — P2 — Build Guide `read_page` luôn đánh giá trang hợp lệ là chưa hoàn thành

- Vị trí: `packages/plugins/plugin-build-guide-block/src/server/tools/search-guides.ts:281-290`; contract core tại `packages/core/database/src/repository.ts:613-615`.
- Tool gọi `findById(pageId, { appends: [...] })`, nhưng repository hiện tại chỉ nhận `id` và gọi `model.findByPk(id)`. Argument thứ hai bị bỏ qua, nên quan hệ `space` không được load; kiểm tra status của space thất bại.
- Tái hiện: đọc trang bằng `findOne({ filterByTk, appends: ['space'] })` xác nhận cả page và space là `completed`; gọi tool thật vẫn nhận `Page ... is not completed`.
- Hướng sửa: dùng API query có hỗ trợ appends và đồng thời xử lý RR-01 trước khi trả nội dung, tránh sửa chức năng rồi mở thêm đường đọc ngoài ACL.
- Trạng thái: **OPEN**.

## Kiểm chứng và giới hạn

- Inventory: **59 plugin**, **2.372 file source/locale**, **304 file test server**, **99 file test client**. Có scan resource/ACL/snippet, raw middleware, filesystem/process và HTML rendering; không phải đã đọc từng dòng trong toàn bộ 2.372 file.
- Resolve server entry bằng esbuild, `write:false`, dependencies external: **59/59 pass**. Đây là kiểm tra import nội bộ, không phải 59 native builds hoặc kiểm tra dependency runtime.
- Client: **99/99 file, 392/392 test pass** trong một lượt chạy.
- Server chạy tuần tự trên SQLite: **285 file pass, 2 file fail** trong 287 file được chọn; **2.257 test pass, 2 fail, 3 skip**. Không chạy 17 file fixture cài toàn bộ bộ plugin `nocobase`; danh sách ở dưới.
- Phân loại và kiểm tra lại hai lỗi server: `plugin-ai-api/.../response-store-integration.test.ts` timeout khởi tạo với hook 30 giây; chạy riêng với hook 120 giây **15/15 pass**, không đổi source. `plugin-agent-orchestrator/.../harness-tool-plan.test.ts` có kỳ vọng thiếu system tool `getSkill` đang tồn tại trong core; thêm tên này vào expected blocked tools, chạy lại **10/10 pass**. Như vậy cả 287 file được chọn đã có kết quả pass qua lượt chính và lượt kiểm tra lại; **không** ghi nhận một lượt full suite 287/287 pass.
- Năm probe tái hiện finding: **5/5 pass**. Các assertion xác nhận lỗi còn tồn tại; số pass này **không phải** bằng chứng đã sửa lỗi. Probe tạm được lưu trong evidence ngoài repository, không đưa assertion chấp nhận vulnerability vào regression suite.
- ESLint `--fix` đã chạy theo batch trên toàn bộ file TS/TSX sẽ commit, và chạy riêng lại fixture Agent Orchestrator sau khi chỉnh. `git diff --check` pass.
- TypeScript compiler API 5.1.3: **106 file TS/TSX đang thay đổi, 0 diagnostic trong các file này**; 83 diagnostic bên ngoài vẫn còn, gồm dependency `@types/sanitize-html` không tương thích cú pháp với compiler. Không phải full repository typecheck pass.
- Hook pre-commit của repository tự thêm license header vào source/test chưa có header chuẩn và chuẩn hóa BOM. Đã đối chiếu với snapshot trước hook: đây là thay đổi comment/encoding, không đổi logic production. Vì vậy source byte-for-byte trong tarball cũ có thể khác header ở Git commit; không coi archive cũ là bản đóng gói lại từ commit mới.
- Native build/pack của lượt sửa trước được giữ nguyên: IR có 20/20 và FR có 6/6, hai nhóm có giao nhau; xem báo cáo tương ứng. Logic production không đổi trong vòng mới, không build lại chỉ vì sửa tài liệu/test expectation. Không tuyên bố đã build/pack 59 plugin.
- Chưa browser E2E, clean install tarball, migration PostgreSQL/MySQL thật, dịch vụ ngoài, production hoặc dependency/CVE audit mới. Bảng coverage dưới đây ghi mức kiểm tra, không chứng nhận plugin không còn vulnerability.

## Bằng chứng có thể đối chiếu

Evidence local: `%TEMP%\custom-review-round2-20261105\` (tên thư mục giữ ngày bắt đầu lượt review, kết quả chốt ngày 06):

- `inventory.json`, `source-hashes-before.json`, `source-changes-during-review.json`, `server-resolution.json`.
- `client-tests.json`, `client-tests.log`, `server-tests.json`, `server-tests.log`, `server-excluded.json`.
- `review-probes.test.ts`, `probe-tests.log`, `probe-tests-final.log`, hai file danh sách test probe. Để chạy lại probe, copy file về root repo với tên `.custom-round2-probes.test.ts`; dùng config Vitest core và môi trường SQLite biệt lập. Route `round2ToolProbe` chỉ thuộc fixture, không được thêm vào plugin production.
- `eslint.log`, `harness-eslint.log`, `typecheck.json`, `typecheck.log`.

Evidence build/pack FR: `%TEMP%\custom-followup-fix-20261105\receipts.json`, archive và log tương ứng. Không đưa log runtime, database test, credential hoặc tarball vào commit source.

## Coverage từng plugin

Mọi dòng đều có inventory/scan điểm vào và server import resolution. Cột test là số **file** pass sau khi đã xử lý/rerun hai lỗi nêu trên; không suy ra coverage từng nhánh. `0` nghĩa là không có file phù hợp trong lượt chạy, không phải plugin đã được chứng minh đúng mà không cần test. Các finding cũ vẫn tra theo báo cáo IR/FR.

| Plugin | Version | Source files | Server pass / excluded | Client pass | New result |
|---|---|---:|---:|---:|---|
| plugin-advance-charts | 1.0.1 | 27 | 0 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-advance-settings | 1.0.0 | 16 | 1 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-agent-orchestrator | 1.1.8 | 174 | 35 / 1 | 1 | Fixture getSkill updated; rerun pass |
| plugin-ai-api | 1.1.6 | 76 | 32 / 0 | 3 | Hook timeout; isolated rerun pass |
| plugin-ai-browser | 1.0.23 | 62 | 5 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-ai-chat-file-preview | 1.1.15 | 12 | 0 / 1 | 2 | No additional confirmed finding in this pass |
| plugin-ai-drawio | 1.1.6 | 61 | 1 / 0 | 5 | No additional confirmed finding in this pass |
| plugin-antd-style-theme | 1.0.15 | 348 | 1 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-api-manager | 1.0.5 | 61 | 22 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-app-observability | 0.1.1 | 48 | 15 / 0 | 3 | No additional confirmed finding in this pass |
| plugin-block-cross-join | 0.1.7 | 19 | 2 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-block-embed-settings | 1.2.17 | 29 | 0 / 0 | 8 | No additional confirmed finding in this pass |
| plugin-block-json | 1.0.0 | 18 | 0 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-block-timeline | 1.0.0 | 19 | 0 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-build-guide-block | 1.1.12 | 37 | 1 / 0 | 0 | OPEN RR-01, RR-05 |
| plugin-build-ui-template | 1.0.6 | 10 | 0 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-build-visualization-block | 0.1.5 | 45 | 4 / 2 | 3 | No additional confirmed finding in this pass |
| plugin-carbone-template-manager | 1.1.16 | 61 | 2 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-cluster-manager | 1.3.3 | 87 | 7 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-crypto-toolkit | 1.0.6 | 41 | 9 / 1 | 0 | No additional confirmed finding in this pass |
| plugin-custom-llm | 1.4.19 | 19 | 1 / 1 | 0 | No additional confirmed finding in this pass |
| plugin-data-cloner | 1.0.4 | 19 | 1 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-data-source-elasticsearch | 1.0.8 | 17 | 2 / 0 | 3 | No additional confirmed finding in this pass |
| plugin-data-source-mssql | 2.0.11 | 20 | 6 / 2 | 2 | No additional confirmed finding in this pass |
| plugin-database-plus-manager | 1.0.0 | 33 | 7 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-docker-registry-ui | 1.0.3 | 47 | 11 / 2 | 9 | No additional confirmed finding in this pass |
| plugin-document-parser | 1.1.8 | 37 | 4 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-document-understanding | 1.1.14 | 31 | 4 / 2 | 0 | OPEN RR-02 |
| plugin-embed-web-client | 1.1.12 | 27 | 0 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-external-storage-manager | 1.1.19 | 26 | 8 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-field-fast-render | 1.0.0 | 12 | 0 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-field-selection-filter | 1.0.5 | 11 | 0 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-field-style-format | 1.0.0 | 14 | 0 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-file-preview-auth | 1.3.13 | 21 | 6 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-file-search | 2.1.19 | 34 | 2 / 0 | 2 | OPEN RR-04 |
| plugin-git-manager | 1.2.27 | 55 | 10 / 1 | 0 | No additional confirmed finding in this pass |
| plugin-ha-scheduler | 1.0.0 | 12 | 2 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-hashicorp-vault-integration | 1.0.4 | 21 | 2 / 1 | 1 | No additional confirmed finding in this pass |
| plugin-header-style-format | 1.0.0 | 11 | 0 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-idp-oidc-client-manager | 1.0.1 | 23 | 1 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-knowledge-base | 1.2.17 | 60 | 15 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-microsoft-graph-gateway | 1.1.2 | 26 | 3 / 0 | 2 | No additional confirmed finding in this pass |
| plugin-n8n | 1.2.4 | 55 | 0 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-next-app-client | 1.3.2 | 34 | 1 / 1 | 5 | No additional confirmed finding in this pass |
| plugin-ocr-verify-block | 0.1.11 | 44 | 0 / 1 | 4 | No additional confirmed finding in this pass |
| plugin-oidc-auth | 1.0.5 | 25 | 2 / 0 | 3 | No additional confirmed finding in this pass |
| plugin-package-registry | 1.0.8 | 19 | 2 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-router-configuration | 1.0.2 | 13 | 2 / 0 | 3 | No additional confirmed finding in this pass |
| plugin-s3-private-storage | 1.0.34 | 20 | 10 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-selector-registry | 0.1.0 | 46 | 11 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-sftp-private-storage | 1.0.20 | 18 | 8 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-sftpgo-integration | 1.1.1 | 24 | 2 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-shared-forms | 2.0.20 | 58 | 2 / 0 | 6 | OPEN RR-03 |
| plugin-skill-creator | 1.0.5 | 8 | 0 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-skill-pptx-advanced | 1.1.9 | 10 | 0 / 0 | 0 | No additional confirmed finding in this pass |
| plugin-skill-registry | 0.2.10 | 72 | 23 / 0 | 4 | No additional confirmed finding in this pass |
| plugin-uipath-orchestrator | 1.0.15 | 57 | 0 / 1 | 2 | No additional confirmed finding in this pass |
| plugin-user-memory | 1.0.14 | 23 | 2 / 0 | 1 | No additional confirmed finding in this pass |
| plugin-visualization-templates | 0.1.26 | 19 | 0 / 0 | 3 | No additional confirmed finding in this pass |

## File server chưa chạy trong lượt biệt lập

- packages/plugins/plugin-agent-orchestrator/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-ai-chat-file-preview/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-build-visualization-block/src/server/__tests__/build-action.test.ts
- packages/plugins/plugin-build-visualization-block/src/server/__tests__/plugin.test.ts
- packages/plugins/plugin-crypto-toolkit/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-custom-llm/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-data-source-mssql/src/server/__tests__/data-source-collections-api.test.ts
- packages/plugins/plugin-data-source-mssql/src/server/__tests__/mssql-data-source.test.ts
- packages/plugins/plugin-docker-registry-ui/src/server/__tests__/desktop-route-migration.test.ts
- packages/plugins/plugin-docker-registry-ui/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-document-understanding/src/server/__tests__/actions.test.ts
- packages/plugins/plugin-document-understanding/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-git-manager/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-hashicorp-vault-integration/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-next-app-client/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-ocr-verify-block/src/server/__tests__/smoke.test.ts
- packages/plugins/plugin-uipath-orchestrator/src/server/__tests__/smoke.test.ts

## Thứ tự xử lý tiếp theo

1. RR-02 và RR-03: chặn đọc file local giả mạo và mass assignment của v1 shared form.
2. RR-01 cùng RR-05: áp ACL cho mọi nhánh Guide tool rồi sửa query `read_page`.
3. RR-04: chuẩn hóa AI tool contract, giữ quyền search của user và kiểm tra invocation thực.
4. Chạy 17 fixture còn lại trong môi trường cài đủ dependency, rồi browser E2E và dịch vụ ngoài theo từng plugin. Các việc này chưa hoàn thành trong snapshot hiện tại.
