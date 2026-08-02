# plugin-docker-registry-ui

Plugin NocoBase 2.x để duyệt, kiểm tra và quản lý Docker Distribution Registry qua API `/v2/`. Plugin hỗ trợ cả image `registry:2` và `registry:3` bằng cách phát hiện capability/media type thay vì phụ thuộc vào số phiên bản runtime.

## Cài đặt

Build và đóng gói từ NocoBase source repository:

```powershell
yarn nocobase build plugin-docker-registry-ui --no-dts
Set-Location packages/plugins/plugin-docker-registry-ui
npm pack
```

Upload file `.tgz` vào Plugin manager, hoặc enable package đã có trong source tree:

```powershell
yarn pm enable plugin-docker-registry-ui
```

## Thiết lập

Mở `/admin/settings/docker-registry` và cấu hình:

- `Internal Registry URL`: URL mà NocoBase server truy cập được, ví dụ `http://registry:5000` trong cùng Docker network.
- `Public Registry host`: host được dùng để tạo lệnh `docker pull/push`, ví dụ `registry.example.com`.
- Authentication: anonymous, basic hoặc static Bearer token.
- TLS/mTLS: verify TLS, custom CA, client certificate/private key và passphrase.
- Behavior: timeout, catalog page size, concurrency, auto refresh, raw manifest, Schema 1 và manifest delete.

Nút **Test connection** kiểm tra chính các giá trị chưa lưu trong form. Secret đã lưu không được trả lại browser; để giữ secret cũ, để trống field tương ứng.

## Sử dụng

- Registry browser: `/docker-registry`
- Settings: `/admin/settings/docker-registry`
- Guide trong ứng dụng: `/admin/settings/docker-registry/guide`

Luồng thông thường: tìm repository, mở danh sách tag, xem digest/size/platform/layers, rồi mở image detail để xem config, history, raw manifest và OCI referrers nếu Registry hỗ trợ.

## Phân quyền

- `pm.docker-registry-ui.read`: xem Registry, repository, tag và image detail.
- `pm.docker-registry-ui.delete`: kiểm tra delete impact và xóa manifest.
- `pm.docker-registry-ui.manage`: toàn bộ quyền read/delete/settings.
- `pm.docker-registry-ui`: alias manage để tương thích cấu hình cũ.

Ngoài ACL snippet, role phải được cấp desktop route Docker Registry thì menu mới xuất hiện.

## Registry 2 và Registry 3

| Chức năng | Registry 2 | Registry 3 |
|---|---|---|
| Catalog, tags, manifests, blobs | Có | Có |
| Docker Schema 2 / OCI image / multi-architecture index | Có | Có |
| OCI Referrers API | Có thể không hỗ trợ; UI tự ẩn | Hiển thị khi server hỗ trợ |
| Xóa manifest theo digest | Cần bật delete trong Registry | Cần bật delete trong Registry |

Xóa một digest có thể ảnh hưởng nhiều tag. Plugin luôn kiểm tra các tag dùng chung digest, yêu cầu xác nhận riêng và từ chối xóa nếu digest đã đổi sau bước xác nhận. Garbage collection của Registry vẫn phải chạy riêng để thu hồi dung lượng vật lý.
