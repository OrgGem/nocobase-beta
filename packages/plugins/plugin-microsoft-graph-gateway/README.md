# Microsoft Graph Gateway

Production-oriented NocoBase gateway for Microsoft Graph Outlook Mail, Microsoft Lists, OneDrive and SharePoint.

## Setup

1. Enable the plugin and open **Settings → Microsoft Graph Gateway → Configuration**.
2. Enter the Entra ID tenant ID, application/client ID and client secret.
3. Grant the application the required Microsoft Graph **application permissions** and tenant admin consent.
4. Save, then select **Test connection**.
5. Open **API Keys**, create a scoped key and copy it immediately.
6. Open **API Documentation** for the deployment-specific base URL and endpoint list.

External requests use `X-API-Key`. Mutating requests should also use a stable `Idempotency-Key` and are processed through the persistent queue. Queue status, retries and audit records are available in **Queue & Audit**.

## Example

```bash
curl -X POST 'https://nocobase.example.com/api/msGraphGateway:sendEmail' \
  -H 'X-API-Key: mgk_xxx' \
  -H 'Idempotency-Key: invoice-10001' \
  -H 'Content-Type: application/json' \
  -d '{
    "user": "sender@company.com",
    "message": {
      "subject": "Invoice 10001",
      "body": { "contentType": "HTML", "content": "<p>Attached invoice.</p>" },
      "toRecipients": [{ "emailAddress": { "address": "customer@example.com" } }]
    }
  }'
```

The response contains `data.jobId`. Query it with `msGraphGateway:getJob` or inspect it in the admin queue.

## Permissions

Grant only permissions needed by enabled API-key scopes. Typical permissions are `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Sites.Read.All`, `Sites.ReadWrite.All`, `Files.Read.All` and `Files.ReadWrite.All`.

Files up to 4 MB can be queued through `uploadFile`. Larger files use `createUploadSession`; the caller uploads chunks directly to the temporary Microsoft upload URL.
