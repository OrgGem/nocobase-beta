# Nâng cấp Skill Registry 0.2

Phiên bản này thay đổi hợp đồng nội bộ giữa Skill Registry và Git Manager để
mọi lần đọc repository đều mang theo danh tính người dùng. Điều này chặn việc
một người có quyền quản lý Skill Registry đọc repository Git nằm ngoài scope
`gitManager:fileContent` của họ.

## Nâng cấp phối hợp

Khi dùng Git source hoặc nút Install vào Agent Orchestrator, hãy nâng cấp cùng
lúc các plugin sau:

| Plugin | Phiên bản tối thiểu | Lý do |
| --- | --- | --- |
| `plugin-git-manager` | `1.2.24` | Cung cấp registry content contract v2 với actor context. |
| `plugin-skill-registry` | `0.2.2` | Truyền actor context, lưu xác nhận repository và khóa install/rollback. |
| `plugin-agent-orchestrator` | `1.1.3` | Tạo tên local skill không va chạm và hỗ trợ rollback an toàn. |

Không nâng cấp riêng Git Manager 1.2.24+ khi một Skill Registry cũ vẫn đang dùng
Git source. Plugin cũ không thể truyền actor context; Git Manager mới sẽ từ
chối request đó thay vì âm thầm bỏ qua repository scope.

## Sau khi nâng cấp

1. Cài Git Manager 1.2.24 và Skill Registry 0.2.2 trong cùng đợt triển khai.
   Không bật lại scheduled sync ở khoảng giữa hai lần nâng cấp.
2. Đăng nhập bằng user có `gitManager:fileContent` trên repository đích.
3. Mở từng Git source trong Skill Registry, lưu lại hoặc chạy manual sync một
   lần. Thao tác này ghi nhận authorization mới.
4. Scheduled sync chỉ chạy lại sau khi source đã được xác nhận. Source cũ chưa
   được xác nhận sẽ có lỗi `SOURCE_REPOSITORY_ACCESS_REAUTHORIZATION_REQUIRED`.

Ví dụ: user `content-editor` có quyền quản lý catalog nhưng chỉ có scope Git
cho repository `42`. Họ có thể tạo/sync source trỏ đến `42`, nhưng không thể
đổi source sang repository `99`. Một scheduler sau đó chỉ sync lại binding
`42` đã được `content-editor` xác nhận; nó không tự có thêm quyền đọc `99`.
