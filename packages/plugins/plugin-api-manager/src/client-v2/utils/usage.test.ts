import { describe, expect, it } from 'vitest';
import {
  buildCurlExample,
  buildDecryptSnippet,
  buildEncryptSnippet,
  buildHmacSigningGuide,
  buildJwtRequirement,
  buildWireContainerDiagram,
  getContainerLabel,
  getRouteEndpoint,
  getRequiredScopes,
} from './usage';

const BASE = 'https://gw.example.com';

describe('usage buildCurlExample', () => {
  it('builds a POST example with body for outbound routes', () => {
    const route = {
      name: 'orders',
      direction: 'outbound' as const,
      method: 'POST',
      targetUrl: 'https://partner.example.com/api/orders',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    const curl = buildCurlExample(route, BASE);
    expect(curl).toContain(`curl -X POST '${BASE}/api/apim/outbound/orders'`);
    expect(curl).toContain("'X-API-Key: <YOUR_API_KEY>'");
    expect(curl).toContain('-d \'{"example": "value"}\'');
  });

  it('builds a GET example without a body', () => {
    const route = {
      name: 'status',
      direction: 'outbound' as const,
      method: 'GET',
      targetUrl: 'https://partner.example.com/status',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    const curl = buildCurlExample(route, BASE);
    expect(curl).toContain(`curl -X GET '${BASE}/api/apim/outbound/status'`);
    expect(curl).not.toContain("-d '");
  });

  it('builds an inbound example with the JSON envelope for encrypted json wire', () => {
    const route = {
      name: 'orders-import',
      direction: 'inbound' as const,
      inboundPath: 'partner/orders',
      method: 'POST',
      targetUrl: 'https://internal.example.com/orders',
      encryptionMode: 'aes-256-gcm' as const,
      wireFormat: 'json' as const,
    };
    const curl = buildCurlExample(route, BASE);
    expect(curl).toContain(`${BASE}/api/apim/inbound/partner/orders`);
    expect(curl).toContain('NCB1');
    expect(curl).toContain('ciphertext');
  });

  it('getRequiredScopes returns bare and route-scoped scopes', () => {
    const route = {
      name: 'orders',
      direction: 'inbound' as const,
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    expect(getRequiredScopes(route)).toEqual(['inbound', 'inbound:orders']);
  });

  it('getRouteEndpoint uses inboundPath for inbound routes', () => {
    const route = {
      name: 'orders-import',
      direction: 'inbound' as const,
      inboundPath: 'partner/orders',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none' as const,
      wireFormat: 'binary' as const,
    };
    expect(getRouteEndpoint(route, BASE)).toBe(`${BASE}/api/apim/inbound/partner/orders`);
  });
});

describe('usage decryption guide builders', () => {
  it('maps encryption modes to wire container labels', () => {
    const base = {
      name: 'r',
      direction: 'inbound' as const,
      method: 'POST',
      targetUrl: 'x',
      wireFormat: 'binary' as const,
    };
    expect(getContainerLabel({ ...base, encryptionMode: 'aes-256-gcm' })).toBe('NCB1');
    expect(getContainerLabel({ ...base, encryptionMode: 'rsa-oaep' })).toBe('NCR1');
    expect(getContainerLabel({ ...base, encryptionMode: 'pgp' })).toBe('openpgp');
  });

  it('documents the NCB1 container layout for aes-256-gcm', () => {
    const diagram = buildWireContainerDiagram({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
    });
    expect(diagram).toContain('NCB1');
    expect(diagram).toContain('scrypt');
    expect(diagram).toContain('auth tag');
  });

  it('documents the NCR1 hybrid container layout for rsa-oaep', () => {
    const diagram = buildWireContainerDiagram({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'rsa-oaep',
      wireFormat: 'json',
    });
    expect(diagram).toContain('NCR1');
    expect(diagram).toContain('RSA-OAEP');
    expect(diagram).toContain('wrappedKey');
    expect(diagram).toContain("the gateway's RSA public key");
  });

  it('uses the partner public key wording for outbound rsa-oaep diagrams', () => {
    const diagram = buildWireContainerDiagram({
      name: 'r',
      direction: 'outbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
    });
    expect(diagram).toContain("the partner's RSA public key");
  });

  it('points PGP at a standard OpenPGP implementation', () => {
    const diagram = buildWireContainerDiagram({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'pgp',
      wireFormat: 'binary',
    });
    expect(diagram).toContain('RFC 4880');
  });

  it('builds an AES decrypt snippet covering raw-key and passphrase modes', () => {
    const snippet = buildDecryptSnippet({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'json',
    });
    expect(snippet).toContain('decryptNcb1');
    expect(snippet).toContain('scryptSync');
    expect(snippet).toContain('aes-256-gcm');
    expect(snippet).toContain('envelope.ciphertext');
  });

  it('builds an RSA hybrid decrypt snippet using OAEP-SHA256', () => {
    const snippet = buildDecryptSnippet({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
    });
    expect(snippet).toContain('decryptNcr1');
    expect(snippet).toContain('RSA_PKCS1_OAEP_PADDING');
    expect(snippet).toContain("oaepHash: 'sha256'");
  });

  it('builds an RSA hybrid encrypt snippet for inbound callers using gateway public key', () => {
    const snippet = buildEncryptSnippet({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'rsa-oaep',
      wireFormat: 'binary',
    });
    expect(snippet).toContain('encryptNcr1');
    expect(snippet).toContain('RSA_PKCS1_OAEP_PADDING');
    expect(snippet).toContain("oaepHash: 'sha256'");
    expect(snippet).toContain("the gateway's RSA public key");
    expect(snippet).toContain('randomBytes');
    expect(snippet).toContain('NCR1');
  });

  it('builds an RSA hybrid encrypt snippet for outbound targets using partner public key', () => {
    const snippet = buildEncryptSnippet({
      name: 'r',
      direction: 'outbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'rsa-oaep',
      wireFormat: 'json',
    });
    expect(snippet).toContain("the partner's RSA public key");
    expect(snippet).toContain('NCR1');
  });

  it('builds an AES encrypt snippet with raw key and passphrase modes', () => {
    const snippet = buildEncryptSnippet({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'aes-256-gcm',
      wireFormat: 'binary',
    });
    expect(snippet).toContain('encryptNcb1');
    expect(snippet).toContain('scryptSync');
    expect(snippet).toContain('aes-256-gcm');
    expect(snippet).toContain('NCB1');
  });

  it('builds a PGP decrypt snippet using openpgp.js', () => {
    const snippet = buildDecryptSnippet({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'pgp',
      wireFormat: 'binary',
    });
    expect(snippet).toContain('openpgp');
    expect(snippet).toContain('readPrivateKey');
  });

  it('describes the HMAC canonical string with the configured tolerance', () => {
    const guide = buildHmacSigningGuide({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none',
      wireFormat: 'binary',
      hmacToleranceSec: 120,
    });
    expect(guide).toContain('X-APIM-Signature');
    expect(guide).toContain('sha256hex');
    expect(guide).toContain('120s');
  });

  it('defaults the HMAC tolerance to 300s', () => {
    const guide = buildHmacSigningGuide({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none',
      wireFormat: 'binary',
    });
    expect(guide).toContain('300s');
  });

  it('describes RS256 JWT requirements when a verify key is set', () => {
    const text = buildJwtRequirement({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none',
      wireFormat: 'binary',
      jwtVerifyKeyName: 'partner-rsa',
      jwtIssuer: 'partner.example.com',
    });
    expect(text).toContain('RS256');
    expect(text).toContain('partner.example.com');
    expect(text).toContain('Authorization: Bearer');
  });

  it('describes HS256 JWT requirements without a verify key', () => {
    const text = buildJwtRequirement({
      name: 'r',
      direction: 'inbound',
      method: 'POST',
      targetUrl: 'x',
      encryptionMode: 'none',
      wireFormat: 'binary',
    });
    expect(text).toContain('HS256');
    expect(text).toContain('shared JWT secret');
  });
});

describe('usage hybrid-json wire format', () => {
  const rsaRoute = {
    name: 'orders-import',
    direction: 'inbound' as const,
    inboundPath: 'partner/orders',
    method: 'POST',
    targetUrl: 'https://internal.example.com/orders',
    encryptionMode: 'rsa-oaep' as const,
    wireFormat: 'hybrid-json' as const,
  };

  it('builds a curl example with the exposed-fields JSON body for rsa-oaep', () => {
    const curl = buildCurlExample(rsaRoute, BASE);
    expect(curl).toContain(`${BASE}/api/apim/inbound/partner/orders`);
    expect(curl).toContain('encryptedKey');
    expect(curl).toContain('nonce');
    expect(curl).toContain('tag');
    expect(curl).toContain('ciphertext');
    expect(curl).not.toContain('"container"');
  });

  it('builds a curl example without encryptedKey for aes-256-gcm', () => {
    const curl = buildCurlExample(
      {
        ...rsaRoute,
        encryptionMode: 'aes-256-gcm',
      },
      BASE,
    );
    expect(curl).toContain('nonce');
    expect(curl).toContain('ciphertext');
    expect(curl).not.toContain('encryptedKey');
  });

  it('labels the container as hybrid-json', () => {
    expect(getContainerLabel(rsaRoute)).toBe('hybrid-json');
  });

  it('documents the rsa-oaep hybrid-json envelope layout', () => {
    const diagram = buildWireContainerDiagram(rsaRoute);
    expect(diagram).toContain('encryptedKey');
    expect(diagram).toContain('nonce');
    expect(diagram).toContain('tag');
    expect(diagram).toContain('ciphertext');
    expect(diagram).toContain("the gateway's RSA public key");
  });

  it('documents the aes-256-gcm hybrid-json envelope layout', () => {
    const diagram = buildWireContainerDiagram({
      ...rsaRoute,
      encryptionMode: 'aes-256-gcm',
    });
    expect(diagram).toContain('nonce');
    expect(diagram).toContain('tag');
    expect(diagram).toContain('ciphertext');
    expect(diagram).toContain('salt');
  });

  it('builds an rsa-oaep hybrid-json decrypt snippet reading the fields directly', () => {
    const snippet = buildDecryptSnippet(rsaRoute);
    expect(snippet).toContain('decryptHybridJson');
    expect(snippet).toContain('envelope.encryptedKey');
    expect(snippet).toContain('envelope.nonce');
    expect(snippet).toContain('envelope.tag');
    expect(snippet).toContain('envelope.ciphertext');
    expect(snippet).toContain('RSA_PKCS1_OAEP_PADDING');
  });

  it('builds an aes-256-gcm hybrid-json decrypt snippet with salt handling', () => {
    const snippet = buildDecryptSnippet({
      ...rsaRoute,
      encryptionMode: 'aes-256-gcm',
    });
    expect(snippet).toContain('decryptHybridJson');
    expect(snippet).toContain('envelope.salt');
    expect(snippet).toContain('scryptSync');
  });

  it('builds an rsa-oaep hybrid-json encrypt snippet producing the envelope', () => {
    const snippet = buildEncryptSnippet(rsaRoute);
    expect(snippet).toContain('encryptHybridJson');
    expect(snippet).toContain('encryptedKey');
    expect(snippet).toContain('RSA_PKCS1_OAEP_PADDING');
    expect(snippet).toContain("the gateway's RSA public key");
  });

  it('builds an aes-256-gcm hybrid-json encrypt snippet', () => {
    const snippet = buildEncryptSnippet({
      ...rsaRoute,
      encryptionMode: 'aes-256-gcm',
    });
    expect(snippet).toContain('encryptHybridJson');
    expect(snippet).toContain('nonce');
    expect(snippet).toContain('salt');
  });
});
