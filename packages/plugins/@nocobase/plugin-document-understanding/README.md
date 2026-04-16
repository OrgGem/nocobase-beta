# @nocobase/plugin-document-understanding

Generic Document Processing Pipeline Orchestrator cho NocoBase 2.x.
Plugin cho phep cau hinh va thuc thi cac pipeline xu ly tai lieu thong qua external API services (OCR, classification, extraction, ...).

---

## Yeu cau

- NocoBase 2.x
- (Tuy chon) `@nocobase/plugin-ai` neu muon su dung AI tool integration

---

## Cai dat

```bash
yarn nocobase pm add @nocobase/plugin-document-understanding
```

Sau do vao **Settings > Plugin Manager**, tim plugin **Document Understanding** va bat **Enable**.

---

## Huong dan su dung

Sau khi enable plugin, vao **Settings > Document Understanding** se thay giao dien voi 4 tab.

### Buoc 1: Cau hinh Service (Tab "Service Config")

Day la buoc bat buoc dau tien — plugin can biet external service cua ban o dau va xac thuc nhu the nao.

1. Mo tab **Service Config**
2. Dien cac truong:

| Truong | Mo ta | Vi du |
|--------|-------|-------|
| **Base URL** | URL goc cua external document processing service | `http://my-ocr-service:8000` |
| **Auth Type** | Phuong thuc xac thuc | `None`, `API Key`, `Bearer Token`, `Custom Header` |
| **API Key / Token** | Key hoac token (hien thi khi Auth Type khac None) | `sk-abc123...` |
| **Custom Header Name** | Ten header tuy chinh (khi chon Custom Header) | `X-Api-Key` |
| **Default Request Timeout** | Timeout mac dinh cho moi request (ms) | `30000` |
| **Default Retries** | So lan thu lai mac dinh khi loi | `2` |
| **Default Poll Interval** | Khoang thoi gian giua cac lan poll (ms) | `5000` |
| **Default Poll Timeout** | Thoi gian toi da cho poll (ms) | `300000` |
| **Webhook Secret** | Secret de verify webhook callback tu external service | (tuy chon) |

3. Nhan **Save Configuration**

### Buoc 2: Dang ky Endpoints (Tab "Endpoints")

Moi endpoint dai dien cho mot chuc nang cua external service (OCR, classify, extract, ...).

1. Mo tab **Endpoints**
2. Nhan **Add Endpoint**
3. Dien thong tin:

| Truong | Mo ta | Vi du |
|--------|-------|-------|
| **Unique Name** | Ten dinh danh (khong trung) | `ocr`, `classify`, `extract_table` |
| **Subpath** | Duong dan API tuong doi voi Base URL | `/api/v1/ocr` |
| **HTTP Method** | `GET` hoac `POST` | `POST` |
| **Execution Mode** | Cach thuc thi | Xem ben duoi |
| **File Input Mode** | Cach gui file | `None`, `Multipart`, `Base64` |
| **Enabled** | Bat/tat endpoint | `true` |

**Execution Mode giai thich:**

- **Synchronous**: Goi API, nhan ket qua ngay trong response. Phu hop cho cac task nhanh (< 30s).
- **Polling**: Goi API nhan `task_id`, sau do plugin tu dong poll ket qua theo interval. Dien them:
  - `Poll Task ID Field`: truong trong response chua task_id (mac dinh: `task_id`)
  - `Poll Result Field`: truong chua ket qua khi poll thanh cong
  - `Poll Status Field` (tuy chon): truong chua trang thai, kiem tra xem task da xong chua
  - `Poll Completed Value` (tuy chon): gia tri cua status field khi hoan thanh (mac dinh: `completed`)
- **Webhook**: Goi API nhan `task_id`, external service se goi lai webhook khi xong. Plugin tu dong xu ly callback.

**Vi du: Dang ky endpoint OCR dong bo**

```
Name:           ocr
Subpath:        /api/v1/ocr
Method:         POST
Execution Mode: Synchronous
File Input:     Multipart
Enabled:        true
```

**Vi du: Dang ky endpoint classify bat dong bo (polling)**

```
Name:              classify
Subpath:           /api/v1/classify
Method:            POST
Execution Mode:    Polling
Poll Task ID:      task_id
Poll Result Field: result
File Input:        None
Enabled:           true
```

### Buoc 3: Tao Pipeline (Tab "Pipelines")

Pipeline la mot chuoi cac buoc (steps) goi lan luot cac endpoints da dang ky.

1. Mo tab **Pipelines**
2. Nhan **Add Pipeline**
3. Dien:
   - **Name**: ten pipeline (vi du: `full_document_processing`)
   - **Description**: mo ta
   - **Enabled**: bat

**Cau hinh Steps (thong qua API hoac JSON):**

Hien tai giao dien UI cua Pipelines Tab chi ho tro CRUD co ban (name, description, enabled).
De cau hinh steps chi tiet, su dung REST API:

```bash
# Tao pipeline voi steps
curl -X POST http://localhost:13000/api/docUnderstanding:createPipeline \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-nocobase-token>" \
  -d '{
    "name": "full_document_processing",
    "description": "OCR roi classify roi extract",
    "enabled": true,
    "steps": [
      {
        "stepOrder": 1,
        "name": "OCR",
        "endpointId": 1,
        "inputMapping": {},
        "outputAlias": "ocr_result",
        "onError": "fail"
      },
      {
        "stepOrder": 2,
        "name": "Classify",
        "endpointId": 2,
        "inputMapping": {
          "text": "$step[ocr_result].response.text"
        },
        "outputAlias": "classify_result",
        "onError": "fail"
      },
      {
        "stepOrder": 3,
        "name": "Extract Table",
        "endpointId": 3,
        "inputMapping": {
          "text": "$step[ocr_result].response.text",
          "doc_type": "$step[classify_result].response.category"
        },
        "outputAlias": "extract_result",
        "onError": "skip",
        "condition": {
          "field": "$step[classify_result].response.category",
          "op": "eq",
          "value": "invoice"
        }
      }
    ]
  }'
```

**Input Mapping DSL:**

| Cu phap | Mo ta | Vi du |
|---------|-------|-------|
| `$input.fieldName` | Lay tu input goc cua pipeline | `$input.document_url` |
| `$step[alias].response.path` | Lay tu ket qua step truoc (theo alias) | `$step[ocr_result].response.text` |
| `$step[1].response.path` | Lay tu ket qua step truoc (theo so thu tu) | `$step[1].response.text` |
| `$files` | Toan bo files dau vao | `$files` |
| Gia tri co dinh | String literal | `"invoice"` |

**Condition operators ho tro:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`

**onError options:** `fail` (dung pipeline), `skip` (bo qua step), `retry` (thu lai theo retryCount)

### Buoc 4: Chay Pipeline

**Cach 1: Qua REST API**

```bash
# Chay pipeline (tham so la pipelineId)
curl -X POST http://localhost:13000/api/docUnderstanding:executePipeline \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-nocobase-token>" \
  -d '{
    "pipelineId": 1,
    "input": {
      "document_url": "https://example.com/invoice.pdf"
    }
  }'

# Response:
# { "jobId": 42 }
```

```bash
# Kiem tra trang thai job
curl http://localhost:13000/api/docUnderstanding:getJobStatus?jobId=42 \
  -H "Authorization: Bearer <your-nocobase-token>"

# Response:
# {
#   "id": 42,
#   "status": "completed",
#   "stepResults": { "ocr_result": {...}, "classify_result": {...} },
#   "finalResult": {...}
# }
```

**Cach 2: Qua AI Employee (neu da cai plugin-ai)**

Khi `@nocobase/plugin-ai` duoc bat, **moi pipeline enabled se tu dong tro thanh mot AI tool/skill rieng biet**.
AI employee co the chon va goi truc tiep pipeline phu hop ma khong can biet pipeline name.

**Cach hoat dong:**

- Plugin dang ky mot **dynamic tools provider** voi AI tools manager.
- Moi khi AI can danh sach tools, provider se query tat ca pipeline co `enabled = true` va tao 1 tool cho moi pipeline.
- Tool name duoc sinh tu pipeline name: `doc_understanding.<sanitized_pipeline_name>`
  - Vi du: pipeline "Full Document Processing" → tool `doc_understanding.full_document_processing`
- Moi tool co:
  - **Title**: `Document: <pipeline name>`
  - **Description**: mo ta pipeline + danh sach steps (vi du: "OCR → Classify → Extract")
  - **Schema**: lay tu `inputSchema` cua pipeline (neu co), hoac fallback la `{ input: object }`

**Vi du: Ban co 3 pipelines enabled:**

| Pipeline | Tool name | Mo ta AI nhin thay |
|----------|-----------|-------------------|
| OCR Only | `doc_understanding.ocr_only` | "Thuc hien OCR tren tai lieu. Steps: OCR" |
| Invoice Processing | `doc_understanding.invoice_processing` | "Xu ly hoa don. Steps: OCR → Classify → Extract Table" |
| Contract Analysis | `doc_understanding.contract_analysis` | "Phan tich hop dong. Steps: OCR → NER → Summarize" |

**Khi nguoi dung hoi AI employee:**

```
User: "Phan tich hoa don nay giup toi"

AI tu dong chon tool: doc_understanding.invoice_processing
  - input: { document_url: "..." }

→ Tra ve ket qua JSON sau khi pipeline chay xong (poll toi da 30s)
→ Neu chua xong, tra ve jobId de theo doi
```

**Luu y:**
- Chi pipeline co `enabled = true` moi duoc dang ky lam tool
- Khi ban tao/sua/xoa/bat/tat pipeline, danh sach tools tu dong cap nhat (dynamic, khong can restart)
- Neu pipeline co `inputSchema` duoc dinh nghia, AI se biet chinh xac can truyen tham so gi
- Moi tool hoat dong doc lap — AI employee co the chon dung tool phu hop theo ngu canh

**Tip: Dinh nghia inputSchema cho pipeline de AI hieu ro input can thiet:**

```bash
curl -X POST http://localhost:13000/api/docUnderstanding:updatePipeline/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-nocobase-token>" \
  -d '{
    "inputSchema": {
      "type": "object",
      "properties": {
        "document_url": {
          "type": "string",
          "description": "URL cua tai lieu can xu ly"
        },
        "language": {
          "type": "string",
          "enum": ["vi", "en", "ja"],
          "description": "Ngon ngu cua tai lieu"
        }
      },
      "required": ["document_url"]
    }
  }'
```

Khi do AI se biet chinh xac can `document_url` (bat buoc) va `language` (tuy chon) khi goi tool.

### Buoc 5: Theo doi Jobs (Tab "Jobs history")

1. Mo tab **Jobs history**
2. Xem danh sach jobs voi trang thai:
   - **pending**: Dang cho
   - **running**: Dang chay
   - **polling**: Dang cho ket qua tu external service
   - **completed**: Hoan thanh
   - **failed**: That bai
   - **timeout**: Het thoi gian cho
3. Nhan **View Details** de xem chi tiet:
   - Input da gui
   - Ket qua tung step
   - Ket qua cuoi cung
   - Loi (neu co)

Tab tu dong refresh moi 10 giay.

---

## Webhook Callback

Neu endpoint su dung execution mode **Webhook**, external service can goi callback ve:

```
POST http://localhost:13000/api/docUnderstanding:webhookCallback
Content-Type: application/json
X-Webhook-Signature: sha256=<hmac-hex>   (neu co cau hinh Webhook Secret)

{
  "task_id": "abc-123",
  "result": { ... }
}
```

Plugin se tu dong match `task_id` voi job dang cho va tiep tuc pipeline.

---

## REST API Reference

| Action | Method | URL |
|--------|--------|-----|
| Lay config | GET | `/api/docUnderstanding:getConfig` |
| Cap nhat config | POST | `/api/docUnderstanding:updateConfig` |
| Danh sach endpoints | GET | `/api/docUnderstanding:listEndpoints` |
| Tao endpoint | POST | `/api/docUnderstanding:createEndpoint` |
| Sua endpoint | POST | `/api/docUnderstanding:updateEndpoint/{id}` |
| Xoa endpoint | DELETE | `/api/docUnderstanding:deleteEndpoint/{id}` |
| Danh sach pipelines | GET | `/api/docUnderstanding:listPipelines` |
| Tao pipeline | POST | `/api/docUnderstanding:createPipeline` |
| Sua pipeline | POST | `/api/docUnderstanding:updatePipeline/{id}` |
| Xoa pipeline | DELETE | `/api/docUnderstanding:deletePipeline/{id}` |
| Chay pipeline | POST | `/api/docUnderstanding:executePipeline` |
| Trang thai job | GET | `/api/docUnderstanding:getJobStatus?jobId={id}` |
| Danh sach jobs | GET | `/api/docUnderstanding:listJobs` |
| Webhook callback | POST | `/api/docUnderstanding:webhookCallback` |

---

## Vi du: Pipeline OCR + Extract hoan chinh

```
1. Cau hinh Service Config:
   Base URL: http://docai-service:8000
   Auth Type: API Key
   API Key: sk-my-secret-key

2. Tao 2 endpoints:
   - "ocr":     POST /ocr,     Sync,    Multipart
   - "extract": POST /extract,  Sync,    None

3. Tao pipeline "ocr_and_extract" voi 2 steps:
   Step 1: endpoint=ocr, outputAlias=ocr_out, onError=fail
   Step 2: endpoint=extract, inputMapping={ "text": "$step[ocr_out].response.text" },
           outputAlias=extract_out, onError=fail

4. Chay:
   POST /api/docUnderstanding:executePipeline
   { "pipelineId": 1, "input": {} }
   (gui file qua multipart neu can)

5. Kiem tra ket qua:
   GET /api/docUnderstanding:getJobStatus?jobId=1
```
