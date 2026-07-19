# Microsoft Graph Gateway

Queue-backed NocoBase APIs for Microsoft Graph Outlook Mail, Lists, OneDrive and SharePoint.

Configure an Entra ID application with application permissions, create an API key, then call `msGraphGateway:sendEmail`, `msGraphGateway:listMessages`, `msGraphGateway:listItems`, or `msGraphGateway:listDriveItems`. Mutating operations are persisted in `msGraphGatewayQueue`; use `Idempotency-Key` to make retries safe.
