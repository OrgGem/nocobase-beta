# Plugin Agent Orchestrator

**Hierarchical Multi-Agent Orchestration for NocoBase AI Employees**

Plugin này cho phép các AI Employee trong NocoBase hoạt động theo mô hình **Leader ↔ Sub-Agent**: một AI Employee (Leader) có thể tự động ủy thác (delegate) nhiệm vụ cho các AI Employee khác (Sub-Agent) để xử lý các tác vụ chuyên biệt — tất cả mà không cần sửa đổi core `plugin-ai`.

---

## ✨ Tính năng chính

### 🏗️ Hierarchical Delegation (Ủy thác phân cấp)
- **Leader** nhận yêu cầu từ user → phân tích → gọi Sub-Agent phù hợp qua tool call
- Mỗi Sub-Agent được đăng ký như một tool riêng (ví dụ: `delegate_to_sql_expert`)
- LLM tự chọn Sub-Agent phù hợp nhất dựa trên mô tả của từng agent

### 🔄 Depth Control (Kiểm soát độ sâu)
- Giới hạn số lớp delegation (ví dụ: `maxDepth: 1` = Leader gọi Sub-Agent, Sub-Agent không được gọi tiếp)
- Ngăn chặn vòng lặp vô hạn (circular delegation) — các tool `delegate_to_*` tự động bị loại khỏi Sub-Agent

### ⏱️ Timeout & Abort
- Mỗi rule cấu hình thời gian chờ tối đa (mặc định 120s)
- Khi timeout, stream LLM bị hủy ngay lập tức qua `AbortController` — không tốn thêm token

### 🛡️ Per-Leader Scoping
- Chỉ Leader được cấu hình mới có thể gọi Sub-Agent tương ứng
- Kiểm tra tại thời điểm invoke — không phụ thuộc vào core API

### 📊 Swarm Tracing (Giám sát)
- Ghi log mỗi lần delegation: ai gọi ai, task gì, kết quả ra sao, mất bao lâu
- Trang admin trực quan để theo dõi và debug multi-agent flows

### 🔌 Zero Core Modification
- Chỉ sử dụng **public APIs** từ `@nocobase/ai` và `@nocobase/plugin-ai`
- Không import private classes, không patch core code
- Tương thích NocoBase 2.x — upgrade-safe

---

## 📐 Kiến trúc

```
┌──────────────────────────────────────────────────────────┐
│  User Chat Session                                       │
│  "Hãy phân tích doanh thu Q4 và tạo báo cáo"           │
└─────────────────────┬────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Leader AI Employee (ví dụ: "Project Manager")           │
│                                                          │
│  Tools available:                                        │
│  ├── delegate_to_sql_expert     ← plugin-agent-orch      │
│  ├── delegate_to_report_writer  ← plugin-agent-orch      │
│  └── other_skills               ← plugin-ai built-in     │
└────┬─────────────────────┬───────────────────────────────┘
     │ tool_call            │ tool_call
     ▼                      ▼
┌────────────────┐   ┌─────────────────┐
│ SQL Expert     │   │ Report Writer   │
│ (Sub-Agent)    │   │ (Sub-Agent)     │
│                │   │                 │
│ createReact    │   │ createReact     │
│ Agent + tools  │   │ Agent + tools   │
└───────┬────────┘   └────────┬────────┘
        │ result              │ result
        └─────────┬───────────┘
                  ▼
┌──────────────────────────────────────────────────────────┐
│  Leader tổng hợp kết quả → trả lời user                 │
└──────────────────────────────────────────────────────────┘
```

---

## 🚀 Cài đặt & Kích hoạt

### Yêu cầu
- NocoBase `>= 2.0`
- Plugin `@nocobase/plugin-ai` đã kích hoạt
- Ít nhất 2 AI Employees đã được tạo (1 Leader, 1+ Sub-Agent)

### Bước 1: Cài đặt plugin
```bash
# Trong monorepo NocoBase
yarn build plugin-agent-orchestrator
```

### Bước 2: Kích hoạt
Vào **Settings → Plugin Manager** → tìm "Agent Orchestrator" → **Enable**

### Bước 3: Cấu hình
Sau khi kích hoạt, vào **Settings → AI → Agent Orchestrator**

---

## 📖 Hướng dẫn sử dụng

### Tab 1: Orchestration Rules

Đây là nơi cấu hình quan hệ Leader ↔ Sub-Agent.

#### Tạo rule mới
1. Nhấn **New Rule**
2. Chọn **Leader (Orchestrator)**: AI Employee đóng vai trò điều phối
3. Chọn **Sub-Agent**: AI Employee sẽ nhận nhiệm vụ được ủy thác
4. Cấu hình:
   - **Max Delegation Depth**: Độ sâu tối đa (1-3)
     - `1` = Leader gọi Sub-Agent, Sub-Agent chỉ dùng tool của mình
     - `2` = Sub-Agent có thể gọi tiếp Sub-Agent khác (nếu được cấu hình)
   - **Timeout (ms)**: Thời gian chờ tối đa
     - `120000` (2 phút) — khuyến nghị cho tác vụ đơn giản
     - `300000` (5 phút) — cho tác vụ phức tạp
   - **Enabled**: Bật/tắt rule
5. Nhấn **Save**

#### Ví dụ cấu hình

| Leader | Sub-Agent | Max Depth | Timeout | Mô tả |
|--------|-----------|-----------|---------|-------|
| PM Bot | SQL Expert | 1 | 120s | PM giao truy vấn DB cho SQL Expert |
| PM Bot | Report Writer | 1 | 300s | PM giao viết báo cáo |
| PM Bot | Code Reviewer | 1 | 180s | PM giao review code |

> **Lưu ý**: Leader và Sub-Agent không được trùng nhau. Một Sub-Agent có thể phục vụ nhiều Leader.

### Tab 2: Swarm Tracing

Trang giám sát hiển thị log tất cả các lần delegation:

| Cột | Mô tả |
|-----|-------|
| **Time** | Thời điểm thực thi |
| **Sub-Agent** | Agent được gọi |
| **Task** | Mô tả nhiệm vụ |
| **Status** | ✅ success hoặc ❌ error |
| **Duration** | Thời gian thực thi |
| **Depth** | Độ sâu delegation (0 = cấp đầu tiên) |

Nhấn **Detail** để xem chi tiết: task gốc, kết quả đầy đủ, lỗi (nếu có).

---

## 💡 Best Practices

### 1. Thiết kế Agent hiệu quả

```
✅ NÊN: Mỗi Sub-Agent chuyên một lĩnh vực rõ ràng
   - "SQL Query Expert" — chỉ chạy truy vấn
   - "Document Writer" — chỉ viết tài liệu

❌ KHÔNG NÊN: Sub-Agent làm quá nhiều việc
   - "General Assistant" — quá rộng, Leader không biết khi nào nên gọi
```

### 2. System Prompt cho Leader

Thêm hướng dẫn trong system prompt của Leader để nó biết khi nào nên delegate:

```
Bạn là Project Manager. Khi nhận yêu cầu:
- Cần truy vấn database → delegate cho SQL Expert
- Cần viết báo cáo → delegate cho Report Writer
- Có thể tự trả lời → trả lời trực tiếp

KHÔNG BAO GIỜ tự viết SQL. Luôn delegate cho SQL Expert.
```

### 3. Bio/About cho Sub-Agent

Viết mô tả rõ ràng trong trường `About` của Sub-Agent — nội dung này được LLM đọc để quyết định có gọi agent đó không:

```
Chuyên gia truy vấn PostgreSQL. Có khả năng:
- Viết và tối ưu SQL queries
- Phân tích schema và index
- Giải thích execution plan
Không xử lý: tạo báo cáo, viết code ứng dụng.
```

### 4. Timeout hợp lý

| Loại tác vụ | Timeout khuyến nghị |
|-------------|---------------------|
| Truy vấn DB đơn giản | 30s - 60s |
| Phân tích dữ liệu | 120s |
| Viết tài liệu dài | 300s |
| Tác vụ phức tạp + tool calls | 300s - 600s |

---

## 🔧 Chi tiết kỹ thuật

### Collections

| Collection | Mục đích |
|------------|----------|
| `orchestratorConfig` | Lưu rules Leader ↔ Sub-Agent |
| `orchestratorLogs` | Lưu log delegation (cho Tracing) |

### APIs

| Endpoint | Mô tả |
|----------|-------|
| `orchestratorConfig:list` | Danh sách rules |
| `orchestratorConfig:create` | Tạo rule mới |
| `orchestratorConfig:update` | Cập nhật rule |
| `orchestratorConfig:destroy` | Xóa rule |
| `orchestratorTracing:list` | Danh sách log delegation |
| `orchestratorTracing:get` | Chi tiết một log |

### Execution Flow

```
1. Plugin load
   └─ registerDynamicTools() → đăng ký delegate_to_* tools vào core toolsManager

2. User chat với Leader
   └─ Leader LLM nhận tool list (bao gồm delegate_to_*)
   └─ LLM quyết định gọi delegate_to_sql_expert({ task: "..." })

3. Tool invoke
   ├─ Check per-leader scoping (allowedLeaders)
   ├─ Check depth limit (ORCHESTRATOR_DEPTH_KEY)
   ├─ Resolve LLM model từ Sub-Agent's modelSettings
   ├─ Resolve tools từ Sub-Agent's skillSettings
   ├─ createReactAgent({ llm, tools })
   ├─ executor.stream({ messages: [system, human] }, { signal })
   ├─ Collect AI response chunks
   ├─ Log to orchestratorLogs
   └─ Return result to Leader

4. Leader tổng hợp và trả lời user
```

### Dependencies

| Package | Version | Mục đích |
|---------|---------|----------|
| `@langchain/core` | ^0.3.0 | DynamicStructuredTool, Messages |
| `@langchain/langgraph` | ^0.2.0 | createReactAgent |
| `zod` | ^3.23.0 | Tool schema validation |

---

## 📁 Cấu trúc project

```
plugin-agent-orchestrator/
├── package.json
├── README.md
├── src/
│   ├── index.ts
│   ├── client/
│   │   ├── index.tsx
│   │   ├── plugin.tsx              # Đăng ký settings page
│   │   ├── AIEmployeesContext.tsx   # Shared context (P3 optimization)
│   │   ├── AIEmployeeSelect.tsx     # Reusable select component
│   │   ├── OrchestratorSettings.tsx # Main settings page
│   │   ├── RulesTab.tsx             # CRUD rules
│   │   └── TracingTab.tsx           # Tracing dashboard
│   ├── server/
│   │   ├── index.ts
│   │   ├── plugin.ts               # Main server plugin
│   │   ├── collections/
│   │   │   ├── orchestrator-config.ts
│   │   │   └── orchestrator-logs.ts
│   │   ├── resources/
│   │   │   └── tracing.ts          # Custom read-only resource
│   │   └── tools/
│   │       └── delegate-task.ts     # Core delegation logic
│   └── locale/
│       ├── en-US.json
│       └── vi-VN.json
```

---

## ⚠️ Lưu ý quan trọng

1. **Không sửa core plugin-ai**: Plugin này hoàn toàn standalone, chỉ dùng public APIs
2. **Sub-Agent cần có LLM model**: Mỗi Sub-Agent phải được cấu hình `modelSettings` (llmService + model) trong AI Employee settings
3. **Sub-Agent cần có skills**: Tools/skills được gán cho Sub-Agent trong `skillSettings` sẽ được cấp cho nó khi thực thi delegation
4. **Circular prevention**: Các tool `delegate_to_*` tự động bị loại khỏi Sub-Agent → Sub-Agent không thể gọi lại Leader
5. **Log retention**: `orchestratorLogs` tích lũy theo thời gian — cân nhắc cleanup định kỳ cho production

---

## 📜 License

Apache-2.0
