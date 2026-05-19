# OCR Verify Block

NocoBase plugin for verifying OCR JSON data against a PDF attachment field.

## MVP scope

- Registers an `OCR Verify` block.
- Loads the PDF from a NocoBase attachment field.
- Loads OCR data from a JSON field.
- Normalizes OCR lines/items through a mapping profile.
- Renders PDF through PDF.js CDN with a CDN web worker.
- Draws an overlay for either rectangle coordinates or 4-point polygons.
- Allows editing OCR values.
- Supports `saveDraft`, `accept`, and `reject` actions.
- Updates the JSON field and an optional string status field.
- Stores verify history.
- Optionally calls a configured callback URL with `X-API-Key`.
- Exposes API actions and a Skill Hub-compatible skill template.

## Default OCR JSON shape

```json
{
  "pages": [
    {
      "page": 1,
      "items": [
        {
          "id": "invoice_no",
          "key": "Invoice No",
          "value": "INV-001",
          "confidence": 0.92,
          "position": {
            "page": 1,
            "x": 120,
            "y": 240,
            "width": 180,
            "height": 32,
            "unit": "px"
          },
          "points": [
            { "x": 120, "y": 240 },
            { "x": 300, "y": 240 },
            { "x": 300, "y": 272 },
            { "x": 120, "y": 272 }
          ],
          "status": "pending"
        }
      ]
    }
  ]
}
```

The default mapping profile uses `pages[].items[]`, `key`, `value`, `position`, `points`, `confidence`, and `status`.

## API

- `ocrVerify:getPayload`
- `ocrVerify:saveDraft`
- `ocrVerify:accept`
- `ocrVerify:reject`
- `ocrVerifySettings:get`
- `ocrVerifySettings:save`
- `ocrVerifySettings:testCallback`
- `ocrVerifyMappingProfiles:default`

## Next implementation steps

- Replace manual block field inputs with datasource/collection/field pickers.
- Add current-selection queue mode for table/list selections.
- Add mapping profile editor UI.
- Add callback replay in the history tab.
- Add e2e coverage for PDF rendering and overlay scaling.
