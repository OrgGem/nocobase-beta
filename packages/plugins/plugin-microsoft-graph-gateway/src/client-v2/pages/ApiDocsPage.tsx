import { useFlowContext } from '@nocobase/flow-engine';
import { Alert, Card, Collapse, Descriptions, Input, Spin, Typography, message } from 'antd';
import React, { useEffect, useState } from 'react';
import { useT } from '../locale';
import { actionData, ActionResponse, errorMessage } from './shared';
const { Paragraph, Text, Title } = Typography;
interface OpenApi {
  paths: Record<string, { post?: { summary?: string } }>;
}
export default function ApiDocsPage() {
  const api = useFlowContext().api;
  const t = useT();
  const [doc, setDoc] = useState<OpenApi>();
  useEffect(() => {
    api
      .request<ActionResponse<OpenApi>>({ url: 'msGraphGateway:openapi' })
      .then((response) => setDoc(actionData(response.data)))
      .catch((error) => message.error(errorMessage(error, t('Load failed'))));
  }, [api, t]);
  const base = `${window.location.origin}${window.location.pathname.replace(/\/admin.*$/, '')}`.replace(/\/$/, '');
  if (!doc) return <Spin />;
  return (
    <Card>
      <Title level={3}>{t('Microsoft Graph Gateway API')}</Title>
      <Alert
        type="warning"
        showIcon
        message={t('The API key must be sent in the X-API-Key header. Mutating actions return a queue job ID.')}
      />
      <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }}>
        <Descriptions.Item label={t('Base URL')}>
          <Text copyable>{base}/api</Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('Authentication')}>X-API-Key: mgk_...</Descriptions.Item>
        <Descriptions.Item label={t('Idempotency')}>Idempotency-Key: your-unique-operation-id</Descriptions.Item>
      </Descriptions>
      <Title level={4}>{t('Quick start: send email')}</Title>
      <Paragraph>
        <Input.TextArea
          readOnly
          autoSize={{ minRows: 10 }}
          value={`curl -X POST '${base}/api/msGraphGateway:sendEmail' \\\n  -H 'X-API-Key: mgk_xxx' \\\n  -H 'Idempotency-Key: email-10001' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"user":"sender@company.com","message":{"subject":"Hello","body":{"contentType":"HTML","content":"<p>Hello</p>"},"toRecipients":[{"emailAddress":{"address":"recipient@example.com"}}]}}'`}
        />
      </Paragraph>
      <Title level={4}>{t('Endpoints')}</Title>
      <Collapse
        items={Object.entries(doc.paths).map(([path, value]) => ({
          key: path,
          label: <Text code>POST {path}</Text>,
          children: (
            <>
              <Paragraph>{value.post?.summary}</Paragraph>
              <Paragraph>
                {t(
                  'Send JSON parameters in the request body. Read operations return data and nextCursor; mutating operations return jobId and status.',
                )}
              </Paragraph>
            </>
          ),
        }))}
      />
    </Card>
  );
}
