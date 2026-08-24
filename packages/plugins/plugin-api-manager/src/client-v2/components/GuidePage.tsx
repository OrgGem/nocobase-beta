import { Alert, Space, Table, Typography } from 'antd';
import React from 'react';
import { useT } from '../locale';
import { buildCurlExample, getGatewayOrigin } from '../utils/usage';
import { CodeBlock } from './CodeBlock';

const codeStyle: React.CSSProperties = {
  padding: '1px 6px',
  background: '#f5f5f5',
  border: '1px solid #e8e8e8',
  borderRadius: 4,
  fontSize: 12,
  fontFamily: 'monospace',
};

export const GuidePage: React.FC = () => {
  const t = useT();
  const origin = getGatewayOrigin();

  const outboundExample = buildCurlExample(
    {
      name: 'payments',
      direction: 'outbound',
      method: 'POST',
      targetUrl: 'https://partner.example.com/api/pay',
      encryptionMode: 'none',
      wireFormat: 'binary',
    },
    origin,
  );
  const inboundExample = buildCurlExample(
    {
      name: 'orders-import',
      direction: 'inbound',
      method: 'POST',
      inboundPath: 'orders',
      targetUrl: 'https://internal.example.com/orders',
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'json',
    },
    origin,
  );

  const endpointColumns = [
    { title: t('Direction') as string, dataIndex: 'direction', key: 'direction', width: 110 },
    { title: t('URL pattern') as string, dataIndex: 'pattern', key: 'pattern' },
    { title: t('Route resolved by') as string, dataIndex: 'resolvedBy', key: 'resolvedBy' },
    { title: t('Example') as string, dataIndex: 'example', key: 'example' },
  ];
  const endpointRows = [
    {
      key: 'inbound',
      direction: t('Inbound'),
      pattern: '/api/apim/inbound/<inboundPath>',
      resolvedBy: t('The route "Inbound Path" field'),
      example: '/api/apim/inbound/orders',
    },
    {
      key: 'outbound',
      direction: t('Outbound'),
      pattern: '/api/apim/outbound/<routeName>',
      resolvedBy: t('The route "Name" field'),
      example: '/api/apim/outbound/payments',
    },
  ];

  const scopeColumns = [
    { title: t('Scope') as string, dataIndex: 'scope', key: 'scope', width: 220 },
    { title: t('Allows') as string, dataIndex: 'allows', key: 'allows' },
  ];
  const scopeRows = [
    { key: 'inbound', scope: 'inbound', allows: t('All inbound routes') },
    { key: 'outbound', scope: 'outbound', allows: t('All outbound routes') },
    { key: 'inbound-route', scope: 'inbound:<routeName>', allows: t('Only the inbound route with that name') },
    { key: 'outbound-route', scope: 'outbound:<routeName>', allows: t('Only the outbound route with that name') },
  ];

  const errorColumns = [
    { title: t('Error Code') as string, dataIndex: 'code', key: 'code', width: 260 },
    { title: 'HTTP', dataIndex: 'http', key: 'http', width: 100 },
    { title: t('Meaning') as string, dataIndex: 'meaning', key: 'meaning' },
  ];
  const errorRows = [
    {
      key: 'unauthorized',
      code: 'APIM_UNAUTHORIZED',
      http: '401',
      meaning: t('Missing, invalid, expired or revoked X-API-Key'),
    },
    { key: 'forbidden', code: 'APIM_FORBIDDEN', http: '403', meaning: t('API key scope does not allow this route') },
    {
      key: 'not-found',
      code: 'APIM_ROUTE_NOT_FOUND',
      http: '404',
      meaning: t('Route not found or disabled'),
    },
    {
      key: 'method-not-allowed',
      code: 'APIM_METHOD_NOT_ALLOWED',
      http: '405',
      meaning: t('HTTP method does not match the route method'),
    },
    {
      key: 'too-large',
      code: 'APIM_BODY_TOO_LARGE',
      http: '413',
      meaning: t('Request body exceeds the route Max Body (MB)'),
    },
    { key: 'decrypt', code: 'APIM_DECRYPT_FAILED', http: '400', meaning: t('Inbound body could not be decrypted') },
    { key: 'signature', code: 'APIM_SIGNATURE_INVALID', http: '400', meaning: t('PGP signature verification failed') },
    {
      key: 'timeout',
      code: 'APIM_TIMEOUT',
      http: '504',
      meaning: t('Target did not respond within the route timeout'),
    },
    {
      key: 'upstream',
      code: 'APIM_UPSTREAM_ERROR',
      http: '502',
      meaning: t('Target request failed after all retries'),
    },
    {
      key: 'upstream-decrypt',
      code: 'APIM_UPSTREAM_DECRYPT_FAILED',
      http: '502',
      meaning: t('Outbound response could not be decrypted'),
    },
    {
      key: 'crypto-config',
      code: 'APIM_CRYPTO_CONFIG',
      http: '500',
      meaning: t('Route encryption is misconfigured (missing secret or key)'),
    },
    {
      key: 'hmac',
      code: 'APIM_HMAC_INVALID',
      http: '401',
      meaning: t('HMAC signature verification failed'),
    },
    {
      key: 'jwt',
      code: 'APIM_JWT_INVALID',
      http: '401',
      meaning: t('JWT verification failed or token missing'),
    },
    {
      key: 'rate-limited',
      code: 'APIM_RATE_LIMITED',
      http: '429',
      meaning: t('Rate limit exceeded for this route and API key'),
    },
    {
      key: 'ip-forbidden',
      code: 'APIM_IP_FORBIDDEN',
      http: '403',
      meaning: t('Client IP is not in the route IP allowlist'),
    },
  ];

  const pgpColumns = [
    { title: t('Route field') as string, dataIndex: 'field', key: 'field' },
    { title: t('Outbound request') as string, dataIndex: 'outReq', key: 'outReq' },
    { title: t('Outbound response') as string, dataIndex: 'outRes', key: 'outRes' },
    { title: t('Inbound request') as string, dataIndex: 'inReq', key: 'inReq' },
    { title: t('Inbound response') as string, dataIndex: 'inRes', key: 'inRes' },
  ];
  const dash = '—';
  const pgpRows = [
    {
      key: 'encrypt',
      field: 'pgpEncryptKeyName',
      outReq: t('Encrypt to partner public key'),
      outRes: dash,
      inReq: dash,
      inRes: t('Encrypt to partner public key'),
    },
    {
      key: 'decrypt',
      field: 'pgpDecryptKeyName',
      outReq: dash,
      outRes: t('Decrypt with own private key'),
      inReq: t('Decrypt with own private key'),
      inRes: dash,
    },
    {
      key: 'sign',
      field: 'pgpSignKeyName',
      outReq: t('Sign with own private key'),
      outRes: dash,
      inReq: dash,
      inRes: t('Sign with own private key'),
    },
    {
      key: 'verify',
      field: 'pgpVerifyKeyName',
      outReq: dash,
      outRes: t('Verify partner signature'),
      inReq: t('Verify partner signature'),
      inRes: dash,
    },
  ];

  return (
    <Space direction="vertical" size={24} style={{ width: '100%', maxWidth: 960 }}>
      <div>
        <Typography.Title level={4}>{t('How to call APIs through the proxy')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t(
            'The API Manager gateway proxies requests through two endpoint families. Every request needs an X-API-Key header.',
          )}
        </Typography.Paragraph>
        <CodeBlock
          copyable={false}
          value={[
            `${t('Outbound')}: caller → POST ${origin}/api/apim/outbound/<routeName> → [${t('encrypt')}] → ${t(
              'partner URL',
            )}`,
            `${t('Inbound')}: partner → POST ${origin}/api/apim/inbound/<inboundPath> → [${t('decrypt')}] → ${t(
              'internal backend URL',
            )}`,
          ].join('\n')}
        />
      </div>

      <div>
        <Typography.Title level={5}>{t('Endpoints')}</Typography.Title>
        <Table size="small" pagination={false} columns={endpointColumns} dataSource={endpointRows} />
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message={t('The HTTP method must match the route method (405 otherwise). Disabled routes return 404.')}
        />
      </div>

      <div>
        <Typography.Title level={5}>{t('Authentication')}</Typography.Title>
        <Typography.Paragraph>
          {t(
            'Every gateway request requires the X-API-Key header. Create keys in the API Keys tab — the plaintext key is shown only once and only its hash is stored.',
          )}
        </Typography.Paragraph>
        <Table size="small" pagination={false} columns={scopeColumns} dataSource={scopeRows} />
        <Alert
          style={{ marginTop: 8 }}
          type="info"
          showIcon
          message={t('For inbound routes, the URL uses the Inbound Path but the scope uses the route Name.')}
        />
      </div>

      <div>
        <Typography.Title level={5}>{t('Examples')}</Typography.Title>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          {t(
            'Outbound: the caller sends a plaintext body; the gateway encrypts it first when the route has encryption.',
          )}
        </Typography.Paragraph>
        <CodeBlock value={outboundExample} />
        <Typography.Paragraph style={{ marginBottom: 8, marginTop: 16 }}>
          {t('Inbound: when the route has encryption, the caller must encrypt the body before sending.')}
        </Typography.Paragraph>
        <CodeBlock value={inboundExample} />
      </div>

      <div>
        <Typography.Title level={5}>{t('Encryption')}</Typography.Title>
        <Typography.Paragraph>
          {t('Each route sets encryptionMode (none, aes-256-gcm, pgp, rsa-oaep) and wireFormat (binary or json).')}
        </Typography.Paragraph>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <Typography.Text strong>{t('Outbound')}</Typography.Text>:{' '}
            {t(
              'caller sends plaintext → gateway encrypts the request → target; gateway decrypts the response → caller receives plaintext.',
            )}
          </li>
          <li>
            <Typography.Text strong>{t('Inbound')}</Typography.Text>:{' '}
            {t(
              'caller sends ciphertext → gateway decrypts the request → target; gateway encrypts the response → caller receives ciphertext.',
            )}
          </li>
        </ul>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          {t('With wire format JSON, encrypted payloads travel inside this envelope:')}
        </Typography.Paragraph>
        <CodeBlock
          value={JSON.stringify(
            {
              container: 'NCB1 (AES-256-GCM) / openpgp (PGP) / NCR1 (RSA-OAEP)',
              encoding: 'base64',
              ciphertext: '<BASE64_CIPHERTEXT>',
            },
            null,
            2,
          )}
        />
        <ul style={{ paddingLeft: 20, marginTop: 12 }}>
          <li>{t('With wire format binary, send the raw ciphertext bytes as application/octet-stream.')}</li>
          <li>{t('Decryption accepts both wire formats regardless of the route setting.')}</li>
          <li>
            {t('AES uses a shared secret: a 32-byte base64 key or any passphrase; the env variable takes precedence.')}
          </li>
          <li>
            {t('PGP key names reference Crypto Toolkit keys; private material lives only in environment variables.')}
          </li>
          <li>
            {t(
              'RSA-OAEP is hybrid: the partner RSA public key wraps a fresh AES-256 session key (RSA-OAEP with SHA-256) and the body is encrypted with AES-256-GCM (NCR1 container).',
            )}
          </li>
          <li>
            {t(
              'RSA key names reference Crypto Toolkit keys: rsaEncryptKeyName is the partner RSA public key; rsaDecryptKeyName is the own key whose private material lives in an environment variable.',
            )}
          </li>
          <li>
            {t(
              'Turn off "Response Encrypted" when the other side replies in plaintext: the gateway then skips decrypting outbound responses and encrypting inbound responses.',
            )}
          </li>
        </ul>
        <Table
          size="small"
          pagination={false}
          columns={pgpColumns}
          dataSource={pgpRows}
          style={{ marginTop: 12 }}
          scroll={{ x: 720 }}
        />
      </div>

      <div>
        <Typography.Title level={5}>{t('Security')}</Typography.Title>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            <Typography.Text strong>{t('HMAC request signing')}</Typography.Text>:{' '}
            {t(
              'When HMAC is enabled, requests must carry three headers. The signature covers timestamp, nonce, method, path and the SHA-256 hash of the body.',
            )}
          </li>
          <li>
            <Typography.Text strong>{t('JWT authentication')}</Typography.Text>:{' '}
            {t(
              'When JWT verification is enabled, requests must include an Authorization: Bearer <token> header. RS256 tokens are verified against a Crypto Toolkit RSA public key; HS256 tokens use the shared secret.',
            )}
          </li>
          <li>
            <Typography.Text strong>{t('Rate limiting')}</Typography.Text>:{' '}
            {t(
              'Fixed-window rate limiting per API key and route. When the limit is exceeded the gateway returns 429 with a Retry-After header.',
            )}
          </li>
          <li>
            <Typography.Text strong>{t('IP allowlist')}</Typography.Text>:{' '}
            {t(
              'Restrict access by client IP. Supports exact IPv4/IPv6 addresses and IPv4 CIDR ranges. An empty list allows all clients.',
            )}
          </li>
        </ul>
      </div>

      <div>
        <Typography.Title level={5}>{t('Error responses')}</Typography.Title>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          {t('Errors return a JSON body and an X-Request-Id header you can look up in Request Logs:')}
        </Typography.Paragraph>
        <CodeBlock
          value={JSON.stringify(
            { error: { code: 'APIM_UNAUTHORIZED', message: 'Missing X-API-Key header', requestId: '8f14e45f-...' } },
            null,
            2,
          )}
        />
        <Table
          size="small"
          pagination={false}
          columns={errorColumns}
          dataSource={errorRows}
          style={{ marginTop: 12 }}
        />
      </div>

      <div>
        <Typography.Title level={5}>{t('Good to know')}</Typography.Title>
        <ul style={{ paddingLeft: 20 }}>
          <li>
            {t(
              'X-API-Key, Authorization, cookies and hop-by-hop headers are never forwarded; use the route Forward Headers / Static Headers to control headers reaching the target.',
            )}
          </li>
          <li>
            {t(
              'Request and response bodies are buffered; streaming is not supported. The route Max Body (MB) limit applies.',
            )}
          </li>
          <li>
            {t(
              'Every gateway request is recorded in the Request Logs tab; payloads are stored only when the route has Log Payloads enabled.',
            )}
          </li>
          <li>
            {t('Use the Test button on a route to check connectivity to the target without leaving this page.')}{' '}
            <Typography.Text style={codeStyle}>X-Request-Id</Typography.Text> {t('links a response to its log entry.')}
          </li>
        </ul>
      </div>
    </Space>
  );
};

export default GuidePage;
