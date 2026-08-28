import { Alert, Descriptions, Modal, Space, Tag, Typography } from 'antd';
import React from 'react';
import { useT } from '../locale';
import { buildCurlExample, getRequiredScopes, getRouteEndpoint, type UsageRoute } from '../utils/usage';
import { CodeBlock } from './CodeBlock';

interface RouteUsageModalProps {
  route: UsageRoute | null;
  onClose: () => void;
}

export const RouteUsageModal: React.FC<RouteUsageModalProps> = ({ route, onClose }) => {
  const t = useT();

  if (!route) {
    return <Modal title={t('Usage') as string} open={false} onCancel={onClose} footer={null} />;
  }

  const encrypted = route.encryptionMode !== 'none';
  const requestEncrypted = route.requestEncrypted !== false;
  const responseEncrypted = route.responseEncrypted !== false;
  const [bareScope, routeScope] = getRequiredScopes(route);
  let flowMessage = t('No encryption configured for this route.');
  if (route.direction === 'outbound') {
    const req = requestEncrypted
      ? t('The gateway encrypts the request body before forwarding to the target URL.')
      : t('The gateway forwards the request body as-is (no encryption on send).');
    const resp = responseEncrypted
      ? t('It then decrypts the upstream response before returning it.')
      : t('It then returns the upstream response as-is (no decryption).');
    flowMessage = `${t('Callers send a body to the gateway endpoint.')} ${req} ${resp}`;
  } else {
    const req = requestEncrypted
      ? t('The gateway decrypts the incoming body before forwarding to the backend.')
      : t('The gateway forwards the incoming body as-is (no decryption).');
    const resp = responseEncrypted
      ? t('It then encrypts the backend response before returning it to the caller.')
      : t('It then returns the backend response as-is (no encryption).');
    flowMessage = `${t('Callers send a body to the gateway endpoint.')} ${req} ${resp}`;
  }

  return (
    <Modal title={`${t('Usage') as string}: ${route.name}`} open onCancel={onClose} footer={null} width={760}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label={t('Method') as string}>{route.method}</Descriptions.Item>
          <Descriptions.Item label={t('Endpoint') as string}>
            <Typography.Text code copyable>
              {getRouteEndpoint(route)}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('Target URL') as string}>{route.targetUrl}</Descriptions.Item>
          <Descriptions.Item label={t('Encryption') as string}>
            {route.encryptionMode}
            {encrypted ? ` (${route.wireFormat})` : ''}
          </Descriptions.Item>
        </Descriptions>

        <Alert type="info" showIcon message={flowMessage} />

        <div>
          <Typography.Title level={5}>{t('Required API key scope')}</Typography.Title>
          <Space size={4} wrap>
            <Tag color="blue">{bareScope}</Tag>
            <Typography.Text type="secondary">{t('or')}</Typography.Text>
            <Tag color="blue">{routeScope}</Tag>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">
              {t('Create an API key with one of these scopes in the API Keys tab. Send it in the X-API-Key header.')}
            </Typography.Text>
          </div>
        </div>

        {encrypted && route.direction === 'inbound' && (
          <div>
            <Typography.Title level={5}>{t('Encrypted request body')}</Typography.Title>
            {route.wireFormat === 'json' ? (
              <>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  {t('With wire format JSON, send the ciphertext base64-encoded inside this envelope:')}
                </Typography.Paragraph>
                <CodeBlock
                  value={JSON.stringify(
                    {
                      container:
                        route.encryptionMode === 'pgp'
                          ? 'openpgp'
                          : route.encryptionMode === 'rsa-oaep'
                            ? 'NCR1'
                            : 'NCB1',
                      encoding: 'base64',
                      ciphertext: '<BASE64_CIPHERTEXT>',
                    },
                    null,
                    2,
                  )}
                />
              </>
            ) : (
              <Typography.Paragraph type="secondary">
                {t(
                  'With wire format binary, send the raw ciphertext bytes with Content-Type: application/octet-stream.',
                )}
              </Typography.Paragraph>
            )}
          </div>
        )}

        <div>
          <Typography.Title level={5}>{t('cURL example')}</Typography.Title>
          <CodeBlock value={buildCurlExample(route)} />
        </div>
      </Space>
    </Modal>
  );
};

export default RouteUsageModal;
