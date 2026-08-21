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
  const responseEncrypted = route.responseEncrypted !== false;
  const [bareScope, routeScope] = getRequiredScopes(route);
  const flowMessage =
    route.direction === 'outbound'
      ? encrypted
        ? responseEncrypted
          ? t(
              'Callers send a plaintext body to the gateway endpoint. The gateway encrypts it and forwards the request to the target URL, then decrypts the response before returning it.',
            )
          : t(
              'Callers send a plaintext body to the gateway endpoint. The gateway encrypts it and forwards the request to the target URL, then returns the plaintext response as-is.',
            )
        : t(
            'Callers send a plaintext body to the gateway endpoint. The gateway forwards the request to the target URL and returns the response as-is.',
          )
      : encrypted
        ? responseEncrypted
          ? t(
              'Callers must send an already-encrypted body to the gateway endpoint. The gateway decrypts it and forwards the request to the target URL, then encrypts the response before returning it.',
            )
          : t(
              'Callers must send an already-encrypted body to the gateway endpoint. The gateway decrypts it and forwards the request to the target URL, then returns the plaintext response as-is.',
            )
        : t(
            'Callers send the body to the gateway endpoint. The gateway forwards the request to the target URL and returns the response as-is.',
          );

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
