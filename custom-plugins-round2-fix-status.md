# Sửa finding của review vòng 2

Ngày: 2026-11-06. Repository `OrgGem/nocobase-beta`, NocoBase `2.2.37`, baseline `dfbebdc8748974db80794528c698417463ddfe70`.

Đã sửa **RR-01–RR-05 trong 4 plugin** và thêm **31 regression tests**. Trạng thái đóng ở mức source và các kiểm chứng dưới đây; không phải chứng nhận mọi custom plugin hết vulnerability hoặc đã triển khai production.

## Kết quả

| Finding | Plugin | Bản sửa | Regression |
|---|---|---|---|
| RR-01, P1 | build-guide-block | Tool giải quyền list/get của cả page và space bằng context user ở datasource main; áp row scope trong query chính, fallback và kiểm tra space. Từ chối nếu field cần dùng bị hạn chế, không đọc association để đi vòng qua quyền của space. | `src/server/__tests__/tool-acl.test.ts`: thiếu quyền, page/space row scope, field allowlist/except, anonymous, keyword/fallback |
| RR-02, P1 | document-understanding | Bỏ hoàn toàn đọc file local qua `path`/`filepath`. JSON có top-level `files` bị từ chối. Multipart được parse sau ACL bằng memory storage có giới hạn, chỉ chuyển bytes do parser tạo vào service. | `src/server/__tests__/upload-security.test.ts`: JSON giả mạo, multipart thật, input JSON lỗi, count/size limit, thiếu quyền, JSON không kèm file |
| RR-03, P1 | shared-forms | V1 và v2 đều cần quyền view theo row trước submit. V1 lấy whitelist từ schema form, từ chối field ngoài form và thay thế whitelist/updateAssociationValues do client gửi. Relation v1 chỉ liên kết bằng khóa bản ghi có sẵn; payload nested không được tạo/sửa dữ liệu khác. Metadata v1 cũng áp filter quyền. | `src/server/__tests__/legacy-submission-security.test.ts`: thiếu grant, row khác, field ẩn, query override, submit hợp lệ, relation writes, allowed roles và anonymous; giữ các test v2 |
| RR-04, P2 | file-search | Đăng ký theo `ToolsOptions` hiện tại, với `definition` và Zod schema. Invocation giữ prototype Koa, user state và response riêng khi gọi search action thật; áp enableAiTool và kiểm tra input. | `src/server/__tests__/ai-tool-integration.test.ts`: core registry thật, action thật, lọc tài liệu theo row scope, disabled, input lỗi, Koa throw, anonymous |
| RR-05, P2 | build-guide-block | Dùng `findOne` cho page và space với quyền riêng, thay lời gọi `findById` không hỗ trợ appends. Chỉ trả nội dung khi cả hai bản ghi được phép và completed. | Tool đọc được trang hợp lệ; từ chối page/space bị cấm hoặc chưa completed |

Trong lúc kiểm tra keyword search, phát hiện `$iLike` cũ sinh SQL `ILIKE` không hợp lệ trên SQLite. Đã chọn `$iLike` cho PostgreSQL và `$like` cho các dialect khác, giữ filter qua repository và row scope ở cả query chính/fallback. Regression SQLite có keyword chứa dấu gạch dưới; chưa chạy cùng query trên PostgreSQL/MySQL thật.

## Thay đổi hành vi cần biết

- Document upload: tối đa **5 file/request**, **20 MiB/file**, hai text field `pipelineId` và `input` (JSON object, tối đa 1 MiB/field). Không tạo file tạm trên disk. JSON pipeline execution không có file vẫn hoạt động.
- Shared Forms v1: shared submit chỉ tạo bản ghi ở collection gắn với form. Với relation, có thể chọn bản ghi đã tồn tại; tạo/sửa nested record phải dùng API có quyền tương ứng. Đây là giới hạn chủ ý của đường submit được cấp quyền thay cho collection create.
- Guide tool: người gọi cần list/get tương ứng trên cả guide pages và spaces, cùng quyền đọc các field mà thao tác sử dụng. Nếu field bị cấm, tool trả lỗi quyền thay vì tạo snippet hoặc metadata từ field đó.
- File Search: tool vẫn có tên `file_search`, chạy backend với permission mặc định ASK; `enableAiTool=false` hoặc cấu hình mặc định chưa bật tool đều từ chối invocation.

## Kiểm chứng

| Plugin | Version mới | File server | Test server |
|---|---|---:|---:|
| document-understanding | 1.1.15 | 7 | 34 |
| shared-forms | 2.0.21 | 3 | 15 |
| build-guide-block | 1.1.13 | 2 | 16 |
| file-search | 2.1.20 | 3 | 11 |
| **Tổng** | | **15/15 pass** | **76/76 pass** |

- Server chạy bằng `yarn test`, tuần tự, SQLite `:memory:`. Hai fixture Document Understanding `actions.test.ts` và `smoke.test.ts` đã bỏ cài toàn bộ bộ plugin `nocobase`; dùng các base dependency cần thiết và nạp class source thật. Kiểm tra CRUD/config/resource thật, chưa chứng nhận full installation lifecycle.
- Client v1/v2 của bốn plugin: **8/8 file, 16/16 test pass**, dùng config Vitest core với danh sách file rõ ràng.
- ESLint `--fix` trên tất cả TS/TSX thay đổi pass. `git diff --check` pass.
- Compiler API TypeScript 5.1.3: **0 diagnostic trong 11 file TS/TSX thay đổi**; còn **5 diagnostic ngoài phạm vi**, gồm lỗi parse `@types/sanitize-html`. Không gọi đây là full repository typecheck pass.
- PageIndex runner và document pipeline service được mock ở các regression tương ứng để kiểm tra dữ liệu/quyền tại ranh giới gọi dịch vụ. Không gọi LLM hoặc processor ngoài.

## Build và package

Đã native build bằng `yarn nocobase build <plugin> --no-dts`, rồi chạy `npm pack` sau build thành công: **4/4 build, 4/4 pack pass**.

- `plugin-document-understanding-1.1.15.tgz`
- `plugin-shared-forms-2.0.21.tgz`
- `plugin-build-guide-block-1.1.13.tgz`
- `plugin-file-search-2.1.20.tgz`

Kiểm tra bundle client v1, client v2, server, `externalVersion.js`, locale en-US/zh-CN trong output và archive; kiểm tra SHA-256 và source thay đổi bên trong archive. Version patch đã tăng cho cả bốn plugin.

Evidence: `%TEMP%\custom-round2-fixes-20261106\`. Có log từng suite server, `all-client.log`, `client-tests.json`, `typecheck.json`, log ESLint, build/pack từng plugin và `receipts.json` ghi exit code/SHA-256 archive.

Chưa clean-install archive, browser E2E, kiểm tra dịch vụ ngoài hoặc production. Không đổi source core/base plugins. Không có thay đổi schema database cần migration trong lượt này.
