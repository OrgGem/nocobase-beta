export interface UsageRoute {
  name: string;
  direction: 'inbound' | 'outbound';
  method: string;
  inboundPath?: string;
  targetUrl: string;
  encryptionMode: 'none' | 'aes-256-gcm' | 'pgp' | 'rsa-oaep';
  wireFormat: 'binary' | 'json';
  aesKeyName?: string;
  requestEncrypted?: boolean;
  responseEncrypted?: boolean;
}

export function getGatewayOrigin(): string {
  return window.location.origin.replace(/\/+$/, '');
}

export function getRouteEndpoint(route: UsageRoute, origin: string = getGatewayOrigin()): string {
  const prefix = route.direction === 'inbound' ? '/api/apim/inbound/' : '/api/apim/outbound/';
  const segment = route.direction === 'inbound' ? route.inboundPath ?? '' : route.name;
  return `${origin}${prefix}${segment}`;
}

export function getRequiredScopes(route: UsageRoute): [string, string] {
  return [route.direction, `${route.direction}:${route.name}`];
}

export function buildCurlExample(route: UsageRoute, origin: string = getGatewayOrigin()): string {
  const url = getRouteEndpoint(route, origin);
  const requestEncrypted = route.requestEncrypted !== false;
  const encryptedInbound = route.direction === 'inbound' && route.encryptionMode !== 'none' && requestEncrypted;
  const useJsonEnvelope = encryptedInbound && route.wireFormat === 'json';
  const lines = [`curl -X ${route.method} '${url}' \\`, `  -H 'X-API-Key: <YOUR_API_KEY>' \\`];
  if (route.method === 'GET') {
    return lines[0].replace(/ \\$/, '');
  }
  let body: string;
  if (useJsonEnvelope) {
    const container =
      route.encryptionMode === 'pgp' ? 'openpgp' : route.encryptionMode === 'rsa-oaep' ? 'NCR1' : 'NCB1';
    body = JSON.stringify({ container, encoding: 'base64', ciphertext: '<BASE64_CIPHERTEXT>' });
    lines.push(`  -H 'Content-Type: application/json' \\`);
  } else if (encryptedInbound) {
    body = '<BINARY_CIPHERTEXT>';
    lines.push(`  -H 'Content-Type: application/octet-stream' \\`);
  } else {
    body = '{"example": "value"}';
    lines.push(`  -H 'Content-Type: application/json' \\`);
  }
  lines.push(`  -d '${body}'`);
  return lines.join('\n');
}
