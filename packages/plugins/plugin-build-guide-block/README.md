# @nocobase/plugin-build-guide-block

Plugin tạo **User Guide (Hướng dẫn sử dụng)** dạng HTML từ tài liệu đính kèm bằng LLM, hiển thị dưới dạng block trên trang NocoBase.

## Tính năng

### Quản lý Space
- **Tạo Space**: Mỗi Space đại diện cho một bộ hướng dẫn, bao gồm tiêu đề, dịch vụ LLM, model, system prompt, và tài liệu đính kèm (tối đa 10 file).
- **Build bất đồng bộ**: Nhấn "Build" sẽ gửi tài liệu tới LLM để sinh HTML. Quá trình chạy nền — không block request, tránh timeout.
- **Trạng thái**: `draft` → `building` → `completed` | `error`. Build log hiển thị trực tiếp trên bảng quản lý.
- **CRUD đầy đủ**: Tạo, sửa, xóa Space (có xác nhận trước khi xóa).

### User Guide Block
- Thêm block **"User Guide"** vào bất kỳ trang NocoBase nào qua menu "Add Block".
- Chọn Space (chỉ hiển thị các Space đã `completed`) trong cài đặt block.
- HTML được sanitize ở cả server (sanitize-html) và client (DOMPurify) để đảm bảo an toàn.

### Bảo mật
- **ACL**: Chỉ admin với snippet `pm.ai-build-guide` mới CRUD/build được. User `loggedIn` chỉ đọc được HTML (`getHtml`).
- **HTML Sanitization**: Hai lớp bảo vệ — server-side (sanitize-html) + client-side (DOMPurify).
- **Status guard**: API `getHtml` chỉ trả HTML khi Space ở trạng thái `completed`.

### Đa ngôn ngữ
- Hỗ trợ 3 ngôn ngữ: English (`en-US`), Tiếng Việt (`vi-VN`), 中文 (`zh-CN`).

## Kiến trúc

```
src/
├── server/
│   ├── plugin.ts              # Đăng ký actions, ACL
│   ├── actions/
│   │   ├── build.ts           # Build async: đọc docs → gọi LLM → sanitize → lưu HTML
│   │   └── getHtml.ts         # Trả raw HTML (Content-Type: text/html)
│   └── collections/
│       └── ai-build-guide-spaces.ts  # Collection definition
├── client/
│   ├── plugin.tsx             # Đăng ký settings page, block initializer, FlowEngine model
│   ├── UserGuideBlock.tsx     # Render HTML với DOMPurify
│   ├── UserGuideManager.tsx   # Trang quản lý CRUD
│   ├── UserGuideBlockInitializer.tsx
│   ├── UserGuideBlockProvider.tsx
│   ├── schemas/
│   │   └── spacesSchema.ts    # UI schema cho bảng + form
│   ├── components/
│   │   ├── BuildButton.tsx    # Nút Build với auto-refresh
│   │   ├── LLMServiceSelect.tsx
│   │   ├── ModelSelect.tsx
│   │   └── StatusTag.tsx
│   └── models/
│       └── UserGuideBlockModel.ts  # FlowEngine block model
└── locale/
    ├── en-US.json
    ├── vi-VN.json
    └── zh-CN.json
```

## Dependencies

| Package | Loại | Mục đích |
|---------|------|----------|
| `sanitize-html` | dependency | Sanitize HTML phía server |
| `dompurify` | dependency | Sanitize HTML phía client |
| `@nocobase/plugin-ai` | peerDependency | Kết nối LLM service |
| `@nocobase/plugin-file-manager` | peerDependency | Đọc file đính kèm |
| `@langchain/core` | peerDependency | Message types cho LLM |
| `axios` | peerDependency | Fetch file từ URL |

## Cách sử dụng

1. Bật plugin trong Plugin Manager.
2. Vào **Settings → Build Guide Block** để tạo Space.
3. Chọn LLM Service, Model, upload tài liệu, nhấn **Build**.
4. Khi status = `completed`, vào trang bất kỳ → **Add Block → User Guide** → chọn Space.
