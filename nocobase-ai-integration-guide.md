# NocoBase v2.1.x AI Integration — Nghiên cứu & Hướng dẫn tích hợp Client-to-Server

> Phiên bản: NocoBase 2.1.0+  
> Ngày: 2026-06-12  
> Mục tiêu: Hướng dẫn đầy đủ để tích hợp AI Agent từ client tới NocoBase Server

---

## Mục lục

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Thành phần cốt lõi](#2-thành-phần-cốt-lõi)
3. [Cài đặt & Cấu hình NocoBase CLI](#3-cài-đặt--cấu-hình-nocobase-cli)
4. [Xác thực (Authentication)](#4-xác-thực-authentication)
5. [MCP Protocol — Giao tiếp Client-Server](#5-mcp-protocol--giao-tiếp-client-server)
6. [AI Builder — Xây dựng ứng dụng bằng AI](#6-ai-builder--xây-dựng-ứng-dụng-bằng-ai)
7. [AI Employees — Agent nội bộ trong NocoBase](#7-ai-employees--agent-nội-bộ-trong-nocobase)
8. [Knowledge Base (RAG)](#8-knowledge-base-rag)
9. [AI Workflow Nodes](#9-ai-workflow-nodes)
10. [Tích hợp với các AI Agent phổ biến](#10-tích-hợp-với-các-ai-agent-phổ-biến)
11. [Bảo mật & Audit](#11-bảo-mật--audit)
12. [Best Practices & Patterns](#12-best-practices--patterns)

---

## 1. Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                          │
│                                                         │
│  Terminal / VS Code / JetBrains / Web Browser           │
│       │              │              │                   │
│  Claude Code      Codex         OpenCode                │
│       │              │              │                   │
└───────┼──────────────┼──────────────┼───────────────────┘
        │              │              │
        ▼              ▼              ▼
┌─────────────────────────────────────────────────────────┐
│                 INTEGRATION LAYER                        │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ NocoBase CLI │  │ NocoBase MCP │  │   Skills     │  │
│  │  (nb)        │  │  Protocol    │  │  (Knowledge) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                  │                  │          │
└─────────┼──────────────────┼──────────────────┼──────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│                 NOCOBASE SERVER (v2.1.x)                 │
│                                                         │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │  ACL    │ │ Workflow  │ │   Data   │ │    UI     │  │
│  │ Engine  │ │  Engine   │ │  Source  │ │  Schema   │  │
│  └─────────┘ └──────────┘ └──────────┘ └───────────┘  │
│                                                         │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │Plugin AI│ │ KnowBase │ │MCP Server│ │  Plugin   │  │
│  │Employee │ │   (RAG)  │ │  Plugin  │ │  Manager  │  │
│  └─────────┘ └──────────┘ └──────────┘ └───────────┘  │
│                                                         │
│                    ┌──────────┐                          │
│                    │ Database │                          │
│                    │(PG/MySQL)│                          │
│                    └──────────┘                          │
└─────────────────────────────────────────────────────────┘
```

**Hai lớp tích hợp chính:**

| Lớp | Mục đích | Giao thức |
|-----|----------|-----------|
| NocoBase CLI + Skills | Quản trị cấu hình (data modeling, UI, workflow, ACL) | REST API qua CLI |
| NocoBase MCP | CRUD dữ liệu trực tiếp + query phức tạp | Streamable HTTP (MCP) |

---

## 2. Thành phần cốt lõi

### 2.1 NocoBase CLI (`@nocobase/cli`)

Command-line tool để khởi tạo, kết nối và quản lý ứng dụng NocoBase.

| Chức năng | Mô tả |
|-----------|--------|
| Kết nối ứng dụng hiện có | `nb env add` |
| Cài đặt mới | `nb init` (Docker / npm / Git) |
| Quản lý môi trường | `nb env list`, `nb env switch` |
| Vận hành | `nb app start/stop/logs/upgrade` |
| API trực tiếp | `nb api <resource> <action>` |
| Backup/Restore | `nb backup` |

### 2.2 NocoBase Skills

Domain knowledge packages giúp AI Agent hiểu hệ thống cấu hình NocoBase. 9 skills chính:

| # | Skill | Chức năng |
|---|-------|-----------|
| 1 | Environment Management | Quản lý env, cài đặt, deploy, upgrade |
| 2 | Data Modeling | Tạo/quản lý bảng, trường, quan hệ |
| 3 | UI Configuration | Tạo trang, block, popup, linkage |
| 4 | Workflow Management | Tạo, sửa, enable, diagnose workflow |
| 5 | ACL Configuration | Quản lý role, permission, user binding |
| 6 | Solutions (DSL) | Batch-build toàn bộ hệ thống từ YAML |
| 7 | Plugin Management | Xem, enable, disable plugin |
| 8 | Release Management | Cross-environment release, backup |
| 9 | Version Control | Lưu version sau mỗi milestone |

### 2.3 NocoBase MCP Server

Plugin `AI: MCP server` expose endpoint cho AI agents truy cập dữ liệu trực tiếp.

---

## 3. Cài đặt & Cấu hình NocoBase CLI

### 3.1 Yêu cầu hệ thống

- Node.js >= 22
- Yarn 1.x
- NocoBase Server v2.1.0+ (đang chạy hoặc sẽ cài mới)
- AI Agent hỗ trợ Claude hoặc GPT (flagship model khuyến nghị)

### 3.2 Cài đặt CLI

```bash
npm install -g @nocobase/cli
nb --version  # Xác nhận cài đặt thành công
```

### 3.3 Khởi tạo mới (Cài NocoBase mới)

**Giao diện trực quan:**
```bash
nb init --ui
```

Wizard 6 bước:
1. **Getting started** — Chọn: cài mới / quản lý local / kết nối remote
2. **App environment** — Tên app, thư mục lưu, port (mặc định 13000)
3. **App source & version** — Chọn nguồn và phiên bản
4. **Configure database** — Built-in SQLite hoặc custom PostgreSQL/MySQL
5. **Create admin account** — Email + password
6. **Connection & authentication** — App URL + phương thức xác thực

**Chế độ một lệnh (default config):**
```bash
nb init --env=app -y
```

### 3.4 Kết nối NocoBase đang chạy

```bash
nb init --ui
# Chọn "Remote Connection" ở bước 1
# Nhập API Address: http://localhost:13000/api
# Chọn Authentication Method: OAuth (khuyến nghị)
```

Hoặc dùng CLI thuần:
```bash
nb env add production \
  --scope project \
  --api-base-url https://my-nocobase.com/api \
  --auth-type oauth
```

### 3.5 Quản lý môi trường

```bash
nb env list              # Liệt kê tất cả env
nb env switch <name>     # Chuyển env active
nb env remove <name>     # Xóa env
```

**Cấu hình lưu tại:** `~/.nocobase/` (thay đổi qua biến `NB_CLI_ROOT`)

---

## 4. Xác thực (Authentication)

NocoBase v2.1.x hỗ trợ 2 phương thức xác thực cho AI Agent:

### 4.1 API Key Authentication

Phù hợp cho: automation, scripted tasks, CI/CD, development.

```bash
nb env add local \
  --scope project \
  --api-base-url http://localhost:13000/api \
  --auth-type token \
  --access-token <your-api-key>
```

**Tạo API Key:**
1. Đăng nhập NocoBase Admin
2. Vào Settings → API Keys plugin
3. Tạo key mới, gán role phù hợp

**Sử dụng:**
```bash
nb api resource list --env local --resource users
```

**Lưu ý:** Permission = role gắn với API key.

### 4.2 OAuth Authentication

Phù hợp cho: human-attributed operations, audit trail rõ ràng.

```bash
nb env add production \
  --scope project \
  --api-base-url https://my-nocobase.com/api \
  --auth-type oauth

nb env auth production  # Mở browser để đăng nhập
```

**Token lifecycle:**
- Access token: mặc định 1 ngày
- Refresh token: mặc định 7 ngày
- CLI tự động refresh khi access token hết hạn

**Chỉ định role cụ thể:**
```
Header: x-role: <role-name>
```

### 4.3 So sánh

| Tiêu chí | API Key | OAuth |
|----------|---------|-------|
| Setup | Đơn giản, 1 lần | Cần browser login |
| Bảo mật | Key cố định, rủi ro leak | Token ngắn hạn, auto-refresh |
| Audit | Gán cho key | Gán cho user cụ thể |
| Use case | Automation, CI/CD | Interactive, production |
| Rotation | Thủ công | Tự động qua refresh |

---

## 5. MCP Protocol — Giao tiếp Client-Server

### 5.1 Tổng quan

MCP (Model Context Protocol) là chuẩn giao tiếp cho phép AI tools tương tác trực tiếp với dữ liệu NocoBase qua HTTP.

**Endpoint:**
```
Main app:    http(s)://<host>:<port>/api/mcp
Sub-app:     http(s)://<host>:<port>/api/__app/<app_name>/mcp
```

**Transport:** Streamable HTTP

### 5.2 Kích hoạt MCP Server

1. Đăng nhập NocoBase Admin
2. Vào Plugin Manager
3. Enable plugin `AI: MCP server`
4. Plugin tự expose endpoint `/api/mcp`

### 5.3 General Tools (Data Operations)

| Tool | Mô tả | Use case |
|------|--------|----------|
| `resource_list` | Lấy danh sách records | Liệt kê khách hàng, đơn hàng |
| `resource_get` | Lấy chi tiết 1 record | Xem thông tin user cụ thể |
| `resource_create` | Tạo record mới | Thêm khách hàng, tạo task |
| `resource_update` | Cập nhật record | Sửa trạng thái đơn hàng |
| `resource_destroy` | Xóa record | Xóa dữ liệu test |
| `resource_query` | Query phức tạp (aggregation, joins) | Báo cáo, thống kê |

### 5.4 Package API Access

Mở rộng capability qua header `x-mcp-packages`:

```
x-mcp-packages: @nocobase/server,plugin-workflow*,plugin-users
```

> Tên không có scope tự động thêm prefix `@nocobase/`.

**Các package phổ biến:**

| Package | Chức năng |
|---------|-----------|
| `@nocobase/plugin-data-source-main` | Quản lý data source chính (bảng, trường) |
| `@nocobase/plugin-data-source-manager` | Quản lý nhiều data source |
| `@nocobase/plugin-workflow` | Quản lý workflow |
| `@nocobase/plugin-acl` | Quản lý role và permission |
| `@nocobase/plugin-users` | Quản lý users |

### 5.5 Ví dụ tích hợp MCP

**Claude Code + API Key:**
```bash
claude mcp add --transport http nocobase \
  https://my-nocobase.com/api/mcp \
  --header "Authorization: Bearer <your_api_key>"
```

**Claude Code + OAuth:**
```bash
claude mcp add --transport http nocobase \
  https://my-nocobase.com/api/mcp

# Trong Claude Code session:
claude
/mcp  # Chọn MCP service để login
```

**Codex + API Key:**
```bash
export NOCOBASE_API_TOKEN=<your_api_key>
codex mcp add nocobase \
  --url https://my-nocobase.com/api/mcp \
  --bearer-token-env-var NOCOBASE_API_TOKEN
```

**Codex + OAuth:**
```bash
codex mcp add nocobase --url https://my-nocobase.com/api/mcp
codex mcp login nocobase --scopes mcp,offline_access
```

**OpenCode (opencode.json):**
```json
{
  "mcp": {
    "nocobase": {
      "type": "remote",
      "url": "https://my-nocobase.com/api/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <your_api_key>"
      }
    }
  },
  "$schema": "https://opencode.ai/config.json"
}
```

---

## 6. AI Builder — Xây dựng ứng dụng bằng AI

### 6.1 Concept

AI Builder = AI Agent bên ngoài (Claude Code, Codex, v.v.) vận hành NocoBase thông qua CLI + Skills. Agent sử dụng natural language để thực hiện:

- Data modeling (tạo bảng, trường, quan hệ)
- UI configuration (trang, block, form, popup)
- Workflow orchestration (trigger, node chain)
- ACL setup (role, permission policy)
- Plugin development (scaffold, custom block, field, action)

### 6.2 Luồng hoạt động

```
User (natural language)
  │
  ▼
AI Agent (Claude Code / Codex)
  │
  ├── Đọc Skills → hiểu cách thức cấu hình NocoBase
  │
  ├── Gọi CLI commands → thực thi operations
  │   └── nb api collections:create ...
  │   └── nb api uiSchemas:patch ...
  │   └── nb api workflows:create ...
  │
  └── Trả kết quả → User
```

### 6.3 Ví dụ thực tế

**Tạo CRM data model:**
```
User: "Tôi đang xây CRM, hãy thiết kế data model cho customers, contacts, opportunities"

Agent thực hiện:
1. nb api collections:create (customers table)
2. nb api fields:create (name, email, phone, industry, ...)
3. nb api collections:create (contacts table)
4. nb api fields:create (firstName, lastName, position, ...)
5. Tạo relationships (customers hasMany contacts)
```

**Tạo trang quản lý:**
```
User: "Tạo trang quản lý khách hàng với search, bảng dữ liệu, và popup chi tiết"

Agent thực hiện:
1. Tạo menu item
2. Tạo page với filter form block
3. Thêm table block với các cột
4. Cấu hình row click → popup detail view
```

---

## 7. AI Employees — Agent nội bộ trong NocoBase

### 7.1 Tổng quan

Plugin `@nocobase/plugin-ai` (built-in) cung cấp AI Agents chạy trực tiếp trong NocoBase UI.

**Thành phần:**
- **AI Employee** — Agent thực thi, gồm Role + Tools/Skills
- **LLM Service** — Cấu hình model (Provider + model list)
- **Tools** — Đơn vị capability có thể gọi
- **Skills** — Domain knowledge guides
- **Context** — Thông tin môi trường (trang, block, cấu trúc dữ liệu)

### 7.2 Cấu hình LLM Service

1. Vào **System Settings → AI Employees → LLM service**
2. Chọn Provider (OpenAI / Claude / Gemini / DeepSeek / Qwen / Ollama / ...)
3. Nhập API Key + Base URL (nếu cần)
4. Chọn Enabled Models
5. **Test flight** để kiểm tra kết nối

### 7.3 Built-in AI Employees

| Employee | Vai trò | Khả năng |
|----------|---------|----------|
| Atlas | Team Leader | Đa năng, tự dispatch task |
| Dex | Data Organizer | Dịch trường, format, extract |
| Viz | Insight Analyst | Phân tích dữ liệu, trend |
| Lexi | Translation | Dịch đa ngôn ngữ |
| Vera | Research Analyst | Tìm kiếm web, tổng hợp |
| Ellis | Email Expert | Viết email, tóm tắt |
| Orin | Data Modeling | Thiết kế collection, field |
| Nathan | Frontend Engineer | Code snippets |
| Dara | Data Visualization | Chart configuration |

### 7.4 General Skills & Tools

**Skills (knowledge):**
- Data metadata — Truy xuất cấu trúc data model
- Data query — Query với filter, aggregation
- Business analysis report — Tạo báo cáo + visualization
- Document search — Đọc tài liệu preset

**Tools (actions):**
- Form filler — Điền dữ liệu vào form
- Chart generator — Tạo ECharts JSON config
- Load specific SKILLS — Load skill động
- Suggestions — Gợi ý bước tiếp theo

### 7.5 MCP trong AI Employees

AI Employees có thể gọi MCP servers bên ngoài:

**Hỗ trợ transport:**
- Stdio (local process)
- HTTP Streamable / SSE (remote)

**Cấu hình:**
1. System Settings → MCP
2. Add server: Name, Title, Description
3. Stdio: Command, Arguments, Env vars
4. HTTP: URL, Headers
5. Per-tool permission: Ask (xác nhận) / Allow (tự động)

### 7.6 Custom Tools qua Workflow

Tạo tool tùy chỉnh cho AI Employee bằng workflow trigger `AI employee event`:

1. Tạo workflow mới với trigger "AI employee event"
2. Định nghĩa input/output schema
3. Xây node chain xử lý logic
4. Gán tool cho AI Employee

---

## 8. Knowledge Base (RAG)

### 8.1 Plugin

`AI: Knowledge base` — plugin riêng, cần enable thủ công.

### 8.2 Luồng RAG

```
┌──────────┐     ┌───────────────┐     ┌──────────────┐
│ User     │────▶│ Embedding     │────▶│ Vector Store │
│ Question │     │ Model (BERT)  │     │ (FAISS/PG)   │
└──────────┘     └───────────────┘     └──────┬───────┘
                                              │
                                     Top-K chunks
                                              │
                                              ▼
┌──────────┐     ┌───────────────┐     ┌──────────────┐
│ Answer   │◀────│ LLM Generate  │◀────│ Augmented    │
│          │     │               │     │ Prompt       │
└──────────┘     └───────────────┘     └──────────────┘
```

### 8.3 Thành phần

| Component | Mô tả |
|-----------|--------|
| Vector Database | Lưu trữ embedding vectors |
| Vector Store | Quản lý collections của vectors |
| Knowledge Base | Nhóm tài liệu + cấu hình retrieval |
| RAG Integration | Kết nối KB vào AI Employee |

### 8.4 Sử dụng

1. Enable plugin `AI: Knowledge base`
2. Cấu hình Vector Database (PGVector / FAISS)
3. Tạo Knowledge Base, upload tài liệu
4. Gán KB cho AI Employee qua skill "Document search"
5. AI Employee tự động retrieval khi user hỏi liên quan

---

## 9. AI Workflow Nodes

### 9.1 AI Employee Node

Tích hợp AI Employee vào workflow automation:

**Cấu hình:**
- **Select AI Employee** — Chọn employee đã enable
- **Select Model** — LLM model cụ thể
- **Select Operator** — User cho permission context
- **Prompts:**
  - Background (system prompt)
  - Default user message (user prompt, hỗ trợ variable)
- **Attachments:** File hoặc URL
- **Skills and Tools:** Preset (mặc định) hoặc Custom (chọn subset)
- **Web Search:** Bật/tắt

### 9.2 Structured Output

Định nghĩa JSON Schema cho output có cấu trúc:

```json
{
  "type": "object",
  "properties": {
    "sentiment": {
      "title": "Sentiment",
      "type": "string",
      "enum": ["positive", "negative", "neutral"],
      "description": "Sentiment classification"
    },
    "summary": {
      "title": "Summary",
      "type": "string",
      "description": "Brief summary of the content"
    },
    "score": {
      "title": "Confidence Score",
      "type": "number",
      "description": "Confidence score 0-1"
    }
  }
}
```

### 9.3 Approval Settings

| Mode | Hành vi |
|------|---------|
| No required | Tự động tiếp tục |
| Human decision | Chờ người duyệt |
| AI decision | AI tự quyết định có cần review không |

### 9.4 Các LLM Workflow Node khác

- **Text Chat** — Chat text đơn giản
- **Multimodal Chat** — Hỗ trợ image, file
- **Structured Output** — Output JSON schema cố định

---

## 10. Tích hợp với các AI Agent phổ biến

### 10.1 Claude Code + NocoBase

**Kiến trúc:**
```
Terminal / VS Code / JetBrains
  └── Claude Code
        ├── NocoBase Skills (domain knowledge)
        └── NocoBase CLI (thực thi)
              └── NocoBase Server
```

**Setup hoàn chỉnh:**
```bash
# 1. Cài Claude Code
npm install -g @anthropic-ai/claude-code

# 2. Cài NocoBase CLI
npm install -g @nocobase/cli

# 3. Khởi tạo kết nối
nb init --ui
# Hoặc:
nb env add production \
  --api-base-url https://my-app.com/api \
  --auth-type oauth
nb env auth production

# 4. Xác nhận
nb env list

# 5. (Tùy chọn) Thêm MCP cho data access trực tiếp
claude mcp add --transport http nocobase \
  https://my-app.com/api/mcp \
  --header "Authorization: Bearer <key>"
```

### 10.2 Codex + NocoBase

```bash
# API Key mode
export NOCOBASE_API_TOKEN=<key>
codex mcp add nocobase \
  --url https://my-app.com/api/mcp \
  --bearer-token-env-var NOCOBASE_API_TOKEN

# OAuth mode
codex mcp add nocobase --url https://my-app.com/api/mcp
codex mcp login nocobase --scopes mcp,offline_access
```

### 10.3 OpenCode + NocoBase

**File `opencode.json`:**
```json
{
  "mcp": {
    "nocobase": {
      "type": "remote",
      "url": "https://my-app.com/api/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <key>"
      }
    }
  },
  "$schema": "https://opencode.ai/config.json"
}
```

**OAuth:**
```bash
opencode mcp auth nocobase
opencode mcp debug nocobase
```

---

## 11. Bảo mật & Audit

### 11.1 Nguyên tắc quyền hạn

- AI Agent **KHÔNG** có quyền đặc biệt — hoàn toàn phụ thuộc identity/role
- **KHÔNG** bypass NocoBase ACL system
- Áp dụng principle of least privilege

### 11.2 Khuyến nghị Role cho AI Agent

```
Tạo role riêng: ai_builder_editor
  ├── Permissions: Chỉ những resource cần thiết
  ├── Data scope: Giới hạn theo điều kiện
  └── Actions: Chỉ cho phép create/read/update (cẩn thận với delete)
```

**Lộ trình cấp quyền:**
1. Bắt đầu với view-only
2. Thêm create cho data modeling
3. Thêm update cho UI configuration
4. Đánh giá rủi ro trước khi cấp delete

### 11.3 Audit Trail

**Request header tự động:**
```
x-request-source: cli
```

**Log location:**
```
storage/logs/<appName>/request_YYYY-MM-DD.log
```

**Thông tin audit ghi lại:**
- Resource được truy cập
- Action thực hiện
- userId thực hiện
- roleName sử dụng
- Status (success/fail)
- x-request-source (cli / web / mcp)

### 11.4 Checklist bảo mật

- [ ] Tạo API Key riêng cho mỗi AI Agent/environment
- [ ] Sử dụng OAuth cho production
- [ ] Tạo role dedicated với quyền tối thiểu
- [ ] Enable audit logging
- [ ] Review log định kỳ
- [ ] Rotate API keys theo schedule
- [ ] Không share key giữa các agent/user
- [ ] Set IP whitelist nếu có thể

---

## 12. Best Practices & Patterns

### 12.1 Pattern: Multi-environment Setup

```bash
# Development
nb env add dev \
  --api-base-url http://localhost:13000/api \
  --auth-type token \
  --access-token <dev-key>

# Staging
nb env add staging \
  --api-base-url https://staging.myapp.com/api \
  --auth-type oauth

# Production
nb env add prod \
  --api-base-url https://prod.myapp.com/api \
  --auth-type oauth
```

### 12.2 Pattern: Backup trước thay đổi lớn

```bash
# Luôn backup trước khi AI thực hiện thay đổi lớn
nb backup create --env prod --tag "before-ai-modeling"

# Thực hiện thay đổi
nb api collections:create ...

# Nếu có vấn đề
nb backup restore --env prod --tag "before-ai-modeling"
```

### 12.3 Pattern: CLI + MCP kết hợp

| Tác vụ | Dùng CLI | Dùng MCP |
|--------|----------|----------|
| Tạo bảng, trường | ✅ | ❌ |
| Cấu hình UI | ✅ | ❌ |
| CRUD dữ liệu nghiệp vụ | ❌ | ✅ |
| Query phức tạp, aggregation | ❌ | ✅ |
| Workflow management | ✅ | ❌ |
| ACL configuration | ✅ | ❌ |
| Đọc metadata | ✅ | ✅ |

### 12.4 Pattern: Structured AI Workflow

```
1. User yêu cầu (natural language)
2. AI Agent phân tích → chọn skill phù hợp
3. Agent đọc metadata hiện tại (nb api collections:list)
4. Agent lên kế hoạch (tạo bảng → tạo trường → tạo UI)
5. Agent thực thi tuần tự
6. Agent verify kết quả
7. Trả kết quả cho user
```

### 12.5 Lưu ý quan trọng

1. **Version requirement:** NocoBase v2.1.0+ bắt buộc cho tích hợp CLI/MCP
2. **Skills auto-install:** Khi chạy `nb init`, skills tự động được cài
3. **Client v2 only:** AI Plugin Development chỉ generate code cho client-v2 (`/v/` path)
4. **MCP packages header:** Mặc định chỉ có general tools, cần specify header để mở rộng
5. **Rate limiting:** Cân nhắc rate limit khi dùng AI Agent gọi nhiều API liên tục
6. **Idempotency:** Design operations idempotent khi có thể (AI có thể retry)

---

## Tóm tắt luồng tích hợp end-to-end

```
┌─────────────────────────────────────────────────────────────┐
│                     LUỒNG TÍCH HỢP                          │
│                                                             │
│  1. Cài CLI:        npm install -g @nocobase/cli            │
│  2. Kết nối:        nb init --ui (hoặc nb env add)          │
│  3. Xác thực:       OAuth (production) / API Key (dev)      │
│  4. Skills:         Auto-install khi nb init                │
│  5. MCP (optional): Enable plugin + configure agent         │
│  6. Sử dụng:        Natural language → AI → CLI/MCP → NB    │
│  7. Audit:          x-request-source: cli trong mọi request │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Nguồn tham khảo

- https://docs.nocobase.com/ai/quick-start
- https://docs.nocobase.com/ai/mcp/
- https://docs.nocobase.com/nocobase-cli/
- https://docs.nocobase.com/ai-builder/
- https://docs.nocobase.com/ai-builder/security
- https://docs.nocobase.com/ai-employees/
- https://docs.nocobase.com/ai-employees/quick-start
- https://docs.nocobase.com/ai-employees/features/llm-service
- https://docs.nocobase.com/ai-employees/features/mcp
- https://docs.nocobase.com/ai-employees/knowledge-base
- https://docs.nocobase.com/ai-employees/workflow/nodes/employee/configuration
- https://docs.nocobase.com/ai/claude-code
- https://docs.nocobase.com/ai/codex
- https://docs.nocobase.com/ai/opencode
- https://github.com/nocobase/skills
