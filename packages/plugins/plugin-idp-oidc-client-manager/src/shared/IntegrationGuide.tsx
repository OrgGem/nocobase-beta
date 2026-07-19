import React from 'react';
import { Alert, Descriptions, Divider, Modal, Space, Tabs, Tag, Typography } from 'antd';
import type { ClientRecord } from './OidcClientsPage';

export type GuideProviderInfo = {
  issuer?: string;
  discoveryUrl?: string;
  supportedScopes?: string[];
};

type Props = {
  client: ClientRecord | null;
  provider: GuideProviderInfo;
  t: (key: string) => string;
  onClose: () => void;
};

export type IntegrationValues = {
  issuer: string;
  discoveryUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  redirectUri: string;
  scope: string;
  authorizationUrl: string;
};

function withTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

function dynamicLoopbackExample(uri: string) {
  try {
    const url = new URL(uri);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) url.port = '49152';
    return url.toString();
  } catch {
    return uri;
  }
}

function callbackPath(uri: string) {
  try {
    return new URL(uri).pathname;
  } catch {
    return '/signin-oidc';
  }
}

export function buildIntegrationValues(client: ClientRecord, provider: GuideProviderInfo): IntegrationValues {
  const issuer = (provider.issuer || '<issuer>').replace(/\/$/, '');
  const discoveryUrl = provider.discoveryUrl || `${issuer}/.well-known/openid-configuration`;
  const authorizationEndpoint = `${issuer}/idpOAuth/authorize`;
  const tokenEndpoint = `${issuer}/idpOAuth/token`;
  const resource = withTrailingSlash(issuer);
  const configuredRedirect = client.redirectUris[0] || '<redirect-uri>';
  const redirectUri = client.allowDynamicLoopbackPort ? dynamicLoopbackExample(configuredRedirect) : configuredRedirect;
  const scope = client.scopes.join(' ');
  const params = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    code_challenge: '<pkce-code-challenge>',
    code_challenge_method: 'S256',
    state: '<random-state>',
    nonce: '<random-nonce>',
  });
  if (client.scopes.includes('offline_access')) params.set('prompt', 'consent');
  if (client.scopes.includes('api')) params.set('resource', resource);
  return {
    issuer,
    discoveryUrl,
    authorizationEndpoint,
    tokenEndpoint,
    resource,
    redirectUri,
    scope,
    authorizationUrl: `${authorizationEndpoint}?${params.toString()}`,
  };
}

function CodeBlock({ value }: { value: string }) {
  return (
    <Typography.Paragraph copyable={{ text: value }}>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, background: '#f5f5f5' }}>
        {value}
      </pre>
    </Typography.Paragraph>
  );
}

export function IntegrationGuide({ client, provider, t, onClose }: Props) {
  if (!client) return null;
  const values = buildIntegrationValues(client, provider);
  const isPublic = client.clientType === 'public';
  const tokenBody = [
    'grant_type=authorization_code',
    `client_id=${client.clientId}`,
    'code=<authorization-code>',
    `redirect_uri=${encodeURIComponent(values.redirectUri)}`,
    'code_verifier=<original-pkce-code-verifier>',
    ...(client.scopes.includes('api') ? [`resource=${encodeURIComponent(values.resource)}`] : []),
    ...(!isPublic && client.tokenEndpointAuthMethod === 'client_secret_post' ? ['client_secret=<client-secret>'] : []),
  ].join('&\n');
  const rawTokenRequest = `POST ${values.tokenEndpoint}\nContent-Type: application/x-www-form-urlencoded${
    !isPublic && client.tokenEndpointAuthMethod === 'client_secret_basic'
      ? '\nAuthorization: Basic <base64(client_id:client_secret)>'
      : ''
  }\n\n${tokenBody}`;
  const nodeConfig = `const oidc = {\n  issuer: '${values.issuer}',\n  discoveryUrl: '${
    values.discoveryUrl
  }',\n  clientId: '${client.clientId}',\n  clientSecret: ${
    isPublic ? 'undefined' : 'process.env.OIDC_CLIENT_SECRET'
  },\n  redirectUri: '${values.redirectUri}',\n  scope: '${values.scope}',\n  resource: '${
    values.resource
  }',\n};\n\n// For every login, generate new state, nonce, code_verifier and S256 code_challenge.\n// Exchange the callback code with the SAME redirectUri and original code_verifier.`;
  const dotnetConfig = `.AddOpenIdConnect("NocoBase", options =>\n{\n    options.Authority = "${
    values.issuer
  }";\n    options.ClientId = "${client.clientId}";${
    isPublic ? '' : '\n    options.ClientSecret = configuration["NocoBaseOidc:ClientSecret"];'
  }\n    options.ResponseType = "code";\n    options.UsePkce = true;\n    options.SaveTokens = true;\n    options.CallbackPath = "${callbackPath(
    values.redirectUri,
  )}";\n    options.Scope.Clear();${client.scopes
    .map((scope) => `\n    options.Scope.Add("${scope}");`)
    .join('')}\n});`;

  return (
    <Modal title={`${t('Integration guide')}: ${client.name}`} open width={960} footer={null} onCancel={onClose}>
      <Tabs
        items={[
          {
            key: 'overview',
            label: t('Overview'),
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  type={client.enabled ? 'info' : 'warning'}
                  showIcon
                  message={
                    client.enabled ? t('Use these values in the external application.') : t('This client is disabled.')
                  }
                />
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label={t('Client type')}>
                    {t(isPublic ? 'Public' : 'Confidential')}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Client ID')}>
                    <Typography.Text copyable>{client.clientId}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Issuer')}>
                    <Typography.Text copyable>{values.issuer}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Discovery URL')}>
                    <Typography.Text copyable>{values.discoveryUrl}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('API resource')}>
                    <Typography.Text copyable>{values.resource}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Callback URL')}>
                    <Typography.Text copyable>{values.redirectUri}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Scopes')}>
                    {client.scopes.map((scope) => (
                      <Tag key={scope}>{scope}</Tag>
                    ))}
                  </Descriptions.Item>
                </Descriptions>
                <Alert
                  type="warning"
                  showIcon
                  message={t('Important requirements')}
                  description={
                    <ul>
                      <li>{t('Use Authorization Code flow with PKCE S256.')}</li>
                      <li>{t('Generate new state, nonce and PKCE values for every login.')}</li>
                      <li>
                        {isPublic
                          ? t('Do not send a client secret for this public client.')
                          : t('Keep the client secret only on the backend.')}
                      </li>
                      {client.scopes.includes('offline_access') ? (
                        <li>{t('Send prompt=consent or offline_access will be removed.')}</li>
                      ) : null}
                      {client.scopes.includes('api') ? (
                        <li>{t('Send the resource parameter to receive a JWT access token for the NocoBase API.')}</li>
                      ) : null}
                      <li>{t('Use access_token, not id_token, to call collection and model APIs.')}</li>
                    </ul>
                  }
                />
                <Divider>{t('Authorization URL template')}</Divider>
                <CodeBlock value={values.authorizationUrl} />
              </Space>
            ),
          },
          {
            key: 'node',
            label: 'Node.js',
            children: (
              <>
                <Alert type="info" showIcon message={t('Use a standards-compliant OIDC library and discovery.')} />
                <CodeBlock value={nodeConfig} />
              </>
            ),
          },
          { key: 'dotnet', label: 'ASP.NET Core', children: <CodeBlock value={dotnetConfig} /> },
          {
            key: 'http',
            label: t('Raw HTTP'),
            children: (
              <>
                <CodeBlock value={values.authorizationUrl} />
                <CodeBlock value={rawTokenRequest} />
              </>
            ),
          },
          {
            key: 'troubleshooting',
            label: t('Troubleshooting'),
            children: (
              <ul>
                <li>
                  {t('No refresh token: include offline_access and prompt=consent in the authorization request.')}
                </li>
                <li>{t('Opaque access token or API 401: include scope api and the exact API resource parameter.')}</li>
                <li>
                  {t(
                    'invalid_redirect_uri: scheme, host, path and query must match; only an enabled native loopback port may vary.',
                  )}
                </li>
                <li>
                  {t(
                    'invalid_client: public clients must not send a secret; confidential clients must use the configured authentication method.',
                  )}
                </li>
                <li>{t('PKCE failure: reuse the original code_verifier and do not regenerate it in the callback.')}</li>
              </ul>
            ),
          },
        ]}
      />
    </Modal>
  );
}

export default IntegrationGuide;
