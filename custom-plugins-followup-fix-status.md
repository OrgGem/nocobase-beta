# Sửa các issue còn lại trong custom plugins

> **Cập nhật 2026-11-06:** snapshot này được đưa vào đợt commit/push theo yêu cầu. Xem [review vòng 2](custom-plugins-review-round2.md) để biết 5 finding mới còn OPEN, coverage 59 plugin và kiểm chứng trước commit. Các trạng thái working tree/build/test bên dưới mô tả thời điểm của lượt cũ.

Ngày: 2026-11-05. Repository `OrgGem/nocobase-beta`, baseline `070854510da07be27c0ebb1e06aa7dad43fa4efc`, NocoBase `2.2.37`.

Đã sửa **9 finding FR-01–FR-09 trong 6 custom plugin** của lượt kiểm tra tiếp theo sau IR-01–IR-17. Đây là trạng thái working tree; chưa commit, push hay triển khai. Giữ các bản sửa IR trước đó và không sửa source core/base plugins.

## Kết quả theo finding

| Finding | Plugin | Thay đổi | Regression chính |
|---|---|---|---|
| FR-01, P1 | ai-browser | Health API chỉ trả availability/driver. Bỏ metadata kết nối khỏi response của người dùng thường; lọc URL viewer cũ có credential CDP trong REST và AI tool. Viewer mặc định dùng `/ai-browser-live/`, không lấy từ endpoint CDP. | HTTP health/get/prepareSession, tool get_session, driver-config |
| FR-02, P1 | ai-browser | Service get/stop/list/conversation bắt buộc nhận identity và owner scope hoặc quyền admin. Artifact kiểm tra session trước khi đọc; workflow cache theo owner, kể cả chọn tự động. Open URL kiểm tra chủ sở hữu conversation. | Tool registry thật với SQLite: đọc/dừng phiên khác, artifact, sáu tool dùng conversation, cache, anonymous, owner và admin |
| FR-03, P1 | data-source-elasticsearch | Bỏ bypass `loggedIn` ở testConnection/readIndices; dùng quyền từ snippet quản trị datasource. | HTTP user thường trả 403 trước outbound request; admin được đọc indices từ fixture HTTP local |
| FR-04, P1 | build-guide-block | getHtml/getMarkdown giải quyền `get` và áp row/field scope trước khi đọc nội dung; giữ response HTML/Markdown không bọc JSON. | HTTP không quyền, row khác, field bị cấm và nội dung được phép |
| FR-05, P1 | file-preview-auth | Xóa hoàn toàn dữ liệu OCR giả. Lỗi executable, PDF conversion, TSV thiếu/sai được truyền lên worker; ghi `failed`, xóa data cũ và lưu thông báo i18n. Chạy subprocess với `shell: false`. | Engine thiếu, exit khác 0, TSV thiếu/sai, PDF lỗi/không có trang, TSV thật và trang trắng |
| FR-06, P2 | file-preview-auth | Lấy attachment bằng `file-manager.getFileStream()`, ghi file tạm riêng và dọn sau xử lý. Storage adapter chịu trách nhiệm document root/path/filename và remote stream. | LocalStorage thật đọc đúng bytes từ root/path/filename; remote stream; cleanup; lỗi storage/engine |
| FR-07, P2 | block-cross-join | Flow cấu hình là manual; thêm menu settings gọi configurator rõ ràng. Giữ cấu hình đã lưu ở cùng flow key. | FlowEngine thật: beforeRender không mở modal; menu mở được và render sau khi đóng không mở lại |
| FR-08, P2 | database-plus-manager | Đọc `response.data.data`; giữ đúng chế độ đã lưu khi save. Khóa Save khi load lỗi để tránh ghi đè bằng default. | Component/form thật: load cursor → save cursor; load lỗi không save |
| FR-09, P2 | ai-browser | Dùng `id` làm khóa chính duy nhất; `key` unique và not-null. Update cấu hình theo filter key. Migration chuyển khóa chính ghép về id, giữ dữ liệu; version tăng `1.0.22` → `1.0.23`. | Fresh sync đủ tám collection; create/update config; migration → sync → read/update/insert trên hai dạng bảng cũ; chạy migration lặp lại; duplicate key làm migration thất bại và giữ nguyên dữ liệu |

Ngoài ra đã sửa smoke fixture File Preview Auth: fixture cũ gọi tên package không resolve được và chỉ assert app tồn tại. Fixture mới nạp class source thật, kiểm tra plugin, collection OCR và resource đã đăng ký.

## Bằng chứng kiểm tra

- Thêm **45 regression tests** trong 8 file mới.
- Toàn bộ test server hiện có trong sáu plugin: **23/23 file, 97/97 test pass**, chạy tuần tự trên SQLite `:memory:`. Sau chỉnh kiểu options của migration, chạy lại riêng access-integration: **18/18 pass**.
- Toàn bộ test client v1/v2 hiện có trong sáu plugin: **10/10 file, 29/29 test pass**. Tổng **126 test** trong phạm vi sáu plugin; không phải full repository suite.
- ESLint `--fix` đã pass trên các file TS/TSX thay đổi thuộc sáu plugin, gồm các bản sửa IR hiện có.
- TypeScript compiler API 5.1.3: **0 diagnostic trong 105 file TS/TSX đang thay đổi**, gồm các bản sửa IR trước đó; còn **83 diagnostic ngoài các file này**. Không coi build `--no-dts` là typecheck hoặc kết quả trên là full repository typecheck pass.
- **6/6 native build và 6/6 npm pack pass.** Kiểm tra file bundle client v1, client v2, server, `externalVersion.js`, locale en-US/zh-CN trong output và archive. Gói AI Browser cuối cùng có migration và module lọc URL mới.

Artifact, SHA-256 và log được lưu tại `%TEMP%\custom-followup-fix-20261105\`:

| Plugin | Gói |
|---|---|
| ai-browser | `plugin-ai-browser-1.0.23.tgz` |
| block-cross-join | `plugin-block-cross-join-0.1.7.tgz` |
| build-guide-block | `plugin-build-guide-block-1.1.12.tgz` |
| data-source-elasticsearch | `plugin-data-source-elasticsearch-1.0.8.tgz` |
| database-plus-manager | `plugin-database-plus-manager-1.0.0.tgz` |
| file-preview-auth | `plugin-file-preview-auth-1.3.13.tgz` |

`receipts.json` ghi exit code build/pack, số file và SHA-256 của từng archive. Log và danh sách test được chép cùng thư mục để đối chiếu.

## Giới hạn xác nhận

- PostgreSQL/MySQL/MariaDB migration đã có nhánh chuyển khóa chính trong source; chưa chạy trên database thật của các dialect này. SQLite đã kiểm tra fresh schema và cả hai dạng legacy schema. Migration không tự chọn/xóa dữ liệu nếu config key bị trùng.
- Tesseract/pdftoppm và browser driver được mock ở regression; chưa xác nhận OCR engine thực tế, Browserless, dịch vụ storage bên ngoài hoặc browser E2E.
- Chưa clean-install các archive hay triển khai production. Chưa thực hiện dependency/CVE audit mới, và không kết luận toàn bộ 59 plugin hết mọi vulnerability hoặc backlog v2.
- Toàn bộ repository typecheck vẫn có diagnostics ngoài các file sửa, gồm lỗi parse từ cặp TypeScript 5.1.3 / `@types/sanitize-html` hiện có.
