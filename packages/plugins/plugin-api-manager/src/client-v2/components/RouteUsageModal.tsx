import { Alert, Descriptions, Modal, Space, Steps, Tag, Typography } from 'antd';
import React from 'react';
import { useT } from '../locale';
import {
  buildCurlExample,
  buildDecryptSnippet,
  buildEncryptSnippet,
  buildHmacSigningGuide,
  buildJwtRequirement,
  buildWireContainerDiagram,
  getContainerLabel,
  getRequiredScopes,
  getRouteEndpoint,
  type UsageRoute,
} from '../utils/usage';
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

  // Caller checklist — every step the caller must complete, in order.
  const callerMustEncrypt = route.direction === 'inbound' && encrypted && requestEncrypted;
  const callerMustDecrypt = route.direction === 'inbound' && encrypted && responseEncrypted;
  const hmacRequired = route.direction === 'inbound' && route.hmacVerifyEnabled === true;
  const jwtRequired = route.direction === 'inbound' && route.jwtVerifyEnabled === true;
  const checklist: string[] = [
    `${t('Create an API key with scope')} "${bareScope}" ${t('or')} "${routeScope}" (${t('API Keys')} tab).`,
  ];
  if (callerMustEncrypt) {
    checklist.push(
      `${t('Encrypt your JSON body with')} ${route.encryptionMode} (${t('container')} ${getContainerLabel(route)}).`,
    );
  }
  if (hmacRequired) {
    checklist.push(t('Sign the request with HMAC-SHA256 (see the HMAC section below).'));
  }
  if (jwtRequired) {
    checklist.push(t('Obtain a JWT and send it as Authorization: Bearer <token>.'));
  }
  checklist.push(
    `${t('Send')} ${route.method} ${t('to the endpoint with header')} X-API-Key${
      route.method === 'GET'
        ? ''
        : ` ${t('and the body')} ${
            callerMustEncrypt
              ? route.wireFormat === 'json'
                ? t('(JSON envelope)')
                : route.wireFormat === 'hybrid-json'
                  ? t('(hybrid JSON)')
                  : t('(binary ciphertext)')
              : ''
          }`
    }.`,
  );
  if (callerMustDecrypt) {
    checklist.push(
      `${t('Decrypt the response with')} ${route.encryptionMode} (${t('see the decryption guide below')}).`,
    );
  }

  return (
    <Modal title={`${t('Usage') as string}: ${route.name}`} open onCancel={onClose} footer={null} width={860}>
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
          <Typography.Title level={5}>{t('Caller checklist')}</Typography.Title>
          <Steps direction="vertical" size="small" current={-1} items={checklist.map((title) => ({ title }))} />
        </div>

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

        {encrypted && route.direction === 'inbound' && requestEncrypted && (
          <div>
            <Typography.Title level={5}>{t('Encrypting the request')}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {t(
                'The gateway decrypts the incoming body with its own private key before forwarding. Build the wire container with the gateway RSA public key (route field rsaEncryptKeyName):',
              )}
            </Typography.Paragraph>
            <CodeBlock copyable={false} value={buildWireContainerDiagram(route)} />
            {route.wireFormat === 'json' ? (
              <>
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
                  {t(
                    'With wire format JSON, build the binary container above first, then base64-encode it inside this envelope:',
                  )}
                </Typography.Paragraph>
                <CodeBlock
                  value={JSON.stringify(
                    {
                      container: getContainerLabel(route),
                      encoding: 'base64',
                      ciphertext: '<BASE64_CIPHERTEXT>',
                    },
                    null,
                    2,
                  )}
                />
              </>
            ) : route.wireFormat === 'hybrid-json' ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                {t(
                  'With wire format hybrid-json, send the fields shown above as the JSON body with Content-Type: application/json.',
                )}
              </Typography.Paragraph>
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                {t(
                  'With wire format binary, send the raw container bytes above with Content-Type: application/octet-stream.',
                )}
              </Typography.Paragraph>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
              {t('Reference encryption snippet (Node.js):')}
            </Typography.Paragraph>
            <CodeBlock value={buildEncryptSnippet(route)} maxHeight={340} />
          </div>
        )}

        {callerMustDecrypt && (
          <div>
            <Typography.Title level={5}>{t('Decrypting the response')}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {t(
                'The gateway encrypts the backend response with your (partner) RSA public key before returning it. Decrypt it with your own RSA private key. The response body uses this wire format:',
              )}
            </Typography.Paragraph>
            <CodeBlock copyable={false} value={buildWireContainerDiagram(route)} />
            {route.wireFormat === 'json' && (
              <>
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
                  {t('With wire format JSON the container above is base64-encoded inside this envelope:')}
                </Typography.Paragraph>
                <CodeBlock
                  copyable={false}
                  value={JSON.stringify(
                    {
                      container: getContainerLabel(route),
                      encoding: 'base64',
                      ciphertext: '<BASE64_CIPHERTEXT>',
                      contentType: '<original content type, e.g. application/json>',
                    },
                    null,
                    2,
                  )}
                />
              </>
            )}
            {route.wireFormat === 'hybrid-json' && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                {t(
                  'With wire format hybrid-json the body is the JSON object shown above (Content-Type: application/json).',
                )}
              </Typography.Paragraph>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
              {t('Reference decryption snippet (Node.js):')}
            </Typography.Paragraph>
            <CodeBlock value={buildDecryptSnippet(route)} maxHeight={340} />
          </div>
        )}

        {encrypted && route.direction === 'outbound' && requestEncrypted && (
          <div>
            <Typography.Title level={5}>{t('What the target receives')}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {t(
                'The gateway encrypts your plaintext body with the partner RSA public key (route field rsaEncryptKeyName) before forwarding. The upstream target receives this wire format and decrypts it with its own private key:',
              )}
            </Typography.Paragraph>
            <CodeBlock copyable={false} value={buildWireContainerDiagram(route)} />
            {route.wireFormat === 'json' && (
              <>
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
                  {t('With wire format JSON the container above is base64-encoded inside this envelope:')}
                </Typography.Paragraph>
                <CodeBlock
                  copyable={false}
                  value={JSON.stringify(
                    {
                      container: getContainerLabel(route),
                      encoding: 'base64',
                      ciphertext: '<BASE64_CIPHERTEXT>',
                      contentType: '<original content type, e.g. application/json>',
                    },
                    null,
                    2,
                  )}
                />
              </>
            )}
            {route.wireFormat === 'hybrid-json' && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                {t(
                  'With wire format hybrid-json the body is the JSON object shown above (Content-Type: application/json).',
                )}
              </Typography.Paragraph>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
              {t('Reference decryption snippet for the target (Node.js):')}
            </Typography.Paragraph>
            <CodeBlock value={buildDecryptSnippet(route)} maxHeight={340} />
          </div>
        )}

        {hmacRequired && (
          <div>
            <Typography.Title level={5}>{t('HMAC signing (required)')}</Typography.Title>
            <CodeBlock copyable={false} value={buildHmacSigningGuide(route)} />
          </div>
        )}

        {jwtRequired && (
          <div>
            <Typography.Title level={5}>{t('JWT authentication (required)')}</Typography.Title>
            <CodeBlock copyable={false} value={buildJwtRequirement(route)} />
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
