export interface UsageRoute {
  name: string;
  direction: 'inbound' | 'outbound';
  method: string;
  inboundPath?: string;
  targetUrl: string;
  encryptionMode: 'none' | 'aes-256-gcm' | 'pgp' | 'rsa-oaep';
  wireFormat: 'binary' | 'json' | 'hybrid-json';
  aesKeyName?: string;
  requestEncrypted?: boolean;
  responseEncrypted?: boolean;
  hmacVerifyEnabled?: boolean;
  hmacToleranceSec?: number;
  jwtVerifyEnabled?: boolean;
  jwtVerifyKeyName?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
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
  const useHybridJson = encryptedInbound && route.wireFormat === 'hybrid-json';
  const lines = [`curl -X ${route.method} '${url}' \\`, `  -H 'X-API-Key: <YOUR_API_KEY>' \\`];
  if (route.method === 'GET') {
    return lines[0].replace(/ \\$/, '');
  }
  let body: string;
  if (useHybridJson) {
    const fields: Record<string, string> =
      route.encryptionMode === 'rsa-oaep'
        ? {
            encryptedKey: '<BASE64_RSA_WRAPPED_AES_KEY>',
            nonce: '<BASE64_IV>',
            tag: '<BASE64_TAG>',
            ciphertext: '<BASE64_CIPHERTEXT>',
          }
        : {
            nonce: '<BASE64_IV>',
            tag: '<BASE64_TAG>',
            ciphertext: '<BASE64_CIPHERTEXT>',
          };
    body = JSON.stringify(fields);
    lines.push(`  -H 'Content-Type: application/json' \\`);
  } else if (useJsonEnvelope) {
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

/** Wire container label per mode, mirroring plugin-crypto-toolkit gateway-crypto. */
export function getContainerLabel(route: UsageRoute): string {
  if (route.wireFormat === 'hybrid-json') return 'hybrid-json';
  if (route.encryptionMode === 'pgp') return 'openpgp';
  if (route.encryptionMode === 'rsa-oaep') return 'NCR1';
  return 'NCB1';
}

/**
 * ASCII diagram of the binary wire container the caller must produce (or
 * parse) per encryption mode. Mirrors crypto-core.ts in plugin-crypto-toolkit.
 */
export function buildWireContainerDiagram(route: UsageRoute): string {
  if (route.encryptionMode === 'aes-256-gcm') {
    if (route.wireFormat === 'hybrid-json') {
      return [
        'Hybrid JSON envelope (Content-Type: application/json):',
        '{',
        '  "nonce":      "<base64 12-byte AES-GCM IV>",',
        '  "tag":        "<base64 16-byte AES-GCM auth tag>",',
        '  "ciphertext": "<base64 AES-256-GCM(plaintext)>",',
        '  "salt":       "<base64 16-byte scrypt salt — only when the route uses a passphrase>",',
        '  "contentType": "<original content type, e.g. application/json — optional>"',
        '}',
        '',
        'How to get the key + IV + tag:',
        '  - no "salt" field: key = your configured 32-byte AES key (base64-decoded)',
        '  - "salt" present:   key = scrypt(passphrase, salt, 32)',
        '  - nonce + tag: read from the JSON fields; no decryption needed',
      ].join('\n');
    }
    return [
      'magic  "NCB1"      4 bytes   ASCII container tag (read as-is)',
      'mode               1 byte    0x00 = raw 32-byte key, 0x01 = passphrase (scrypt)',
      'salt              16 bytes   only when mode = 0x01 — PLAINTEXT, used to scrypt-derive the key',
      'iv                12 bytes   AES-GCM nonce — PLAINTEXT, read directly',
      'tag               16 bytes   AES-GCM auth tag — PLAINTEXT, read directly',
      'ciphertext         n bytes   AES-256-GCM(plaintext)',
      '',
      'How to get the key + IV + tag:',
      '  - mode 0x00 (raw key):    key = your configured 32-byte AES key (from the route, base64-decoded)',
      '  - mode 0x01 (passphrase): key = scrypt(passphrase, salt, 32) — salt is read from the container',
      '  - iv + tag: read from the container at the offsets above; no decryption needed',
    ].join('\n');
  }
  if (route.encryptionMode === 'rsa-oaep') {
    const recipientKey =
      route.direction === 'inbound'
        ? "the gateway's RSA public key (route field rsaEncryptKeyName)"
        : "the partner's RSA public key (route field rsaEncryptKeyName)";
    if (route.wireFormat === 'hybrid-json') {
      return [
        'Hybrid JSON envelope (Content-Type: application/json):',
        '{',
        `  "encryptedKey": "<base64 AES-256 session key, WRAPPED with ${recipientKey} (OAEP-SHA256)>",`,
        '  "nonce":        "<base64 12-byte AES-GCM IV — PLAINTEXT, read directly>",',
        '  "tag":          "<base64 16-byte AES-GCM auth tag — PLAINTEXT, read directly>",',
        '  "ciphertext":   "<base64 AES-256-GCM(plaintext) using the session key above>",',
        '  "contentType":  "<original content type, e.g. application/json — optional>"',
        '}',
        '',
        'How to get the AES session key + IV + tag (no extra secrets needed):',
        '  1. sessionKey = RSA-OAEP-DECRYPT(encryptedKey, the recipient private key)  → 32 bytes',
        '  2. iv         = base64-decode the "nonce" field',
        '  3. tag        = base64-decode the "tag" field',
        '  4. plaintext  = AES-256-GCM-DECRYPT(ciphertext, sessionKey, iv, tag)',
      ].join('\n');
    }
    return [
      'magic  "NCR1"      4 bytes   ASCII container tag (read as-is)',
      'wrappedKeyLen      2 bytes   big-endian length of the wrapped session key',
      `wrappedKey         k bytes   AES-256 session key, WRAPPED with ${recipientKey} (OAEP-SHA256)`,
      'iv                12 bytes   AES-GCM nonce — PLAINTEXT, read directly, no decryption needed',
      'tag               16 bytes   AES-GCM auth tag — PLAINTEXT, read directly',
      'ciphertext         n bytes   AES-256-GCM(plaintext) using the session key above',
      '',
      'How to get the AES session key + IV + tag (no extra secrets needed):',
      '  1. sessionKey = RSA-OAEP-DECRYPT(wrappedKey, the recipient private key)  → 32 bytes',
      '  2. iv         = read the 12 bytes right after wrappedKey       → plaintext in the container',
      '  3. tag        = read the 16 bytes right after iv               → plaintext in the container',
      '  4. plaintext  = AES-256-GCM-DECRYPT(ciphertext, sessionKey, iv, tag)',
      'k = 256 for RSA-2048, 384 for RSA-3072, 512 for RSA-4096.',
    ].join('\n');
  }
  // OpenPGP binary message (RFC 4880) — not a fixed-layout container.
  return [
    'OpenPGP binary message (RFC 4880).',
    'Decrypt with any OpenPGP implementation (gpg, openpgp.js, ...).',
    'The message may also carry a signature when the route configures a sign key.',
  ].join('\n');
}

/**
 * Node.js snippet that decrypts the response (or request) payload this route
 * produces/accepts. Only the AES and RSA hybrid containers get inline code;
 * PGP points the caller at a full OpenPGP library.
 */
export function buildDecryptSnippet(route: UsageRoute): string {
  if (route.encryptionMode === 'aes-256-gcm') {
    if (route.wireFormat === 'hybrid-json') {
      return [
        'const crypto = req' + "uire('crypto');",
        '',
        '// The hybrid-json envelope exposes each crypto field separately:',
        '//   { nonce, tag, ciphertext, salt? } — all base64.',
        'function decryptHybridJson(envelope, secret) {',
        '  // secret: Buffer (32 bytes) or passphrase string',
        '  const iv = Buffer.from(envelope.nonce, "base64");',
        '  const tag = Buffer.from(envelope.tag, "base64");',
        '  const ciphertext = Buffer.from(envelope.ciphertext, "base64");',
        '  let key;',
        '  if (envelope.salt) {',
        '    key = crypto.scryptSync(String(secret), Buffer.from(envelope.salt, "base64"), 32);',
        '  } else {',
        '    key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "base64");',
        '  }',
        '  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);',
        '  decipher.setAuthTag(tag);',
        '  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);',
        '}',
        '',
        '// The original content type is in `envelope.contentType` when present.',
      ].join('\n');
    }
    return [
      'const crypto = req' + "uire('crypto');",
      '',
      'function decryptNcb1(payload, secret) {',
      '  // secret: Buffer (32 bytes) or passphrase string',
      "  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'base64');",
      "  if (buf.subarray(0, 4).toString('ascii') !== 'NCB1') throw new Error('not an NCB1 container');",
      '  const mode = buf[4];',
      '  let offset = 5;',
      '  let key;',
      '  if (mode === 0x00) {',
      "    key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'base64');",
      '  } else {',
      '    const salt = buf.subarray(offset, offset + 16);',
      '    offset += 16;',
      '    key = crypto.scryptSync(String(secret), salt, 32);',
      '  }',
      '  const iv = buf.subarray(offset, offset + 12);',
      '  const tag = buf.subarray(offset + 12, offset + 28);',
      '  const ciphertext = buf.subarray(offset + 28);',
      "  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);",
      '  decipher.setAuthTag(tag);',
      '  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);',
      '}',
      '',
      '// wireFormat "json": parse the body as JSON first and pass',
      '// `envelope.ciphertext` (base64) as `payload`; the original content',
      '// type is in `envelope.contentType` when present.',
    ].join('\n');
  }
  if (route.encryptionMode === 'rsa-oaep') {
    const decryptKey =
      route.direction === 'inbound'
        ? 'your own (partner) RSA private key — the private key matching the public key in rsaEncryptKeyName'
        : 'your own RSA private key — the private key matching the public key the gateway used to encrypt';
    if (route.wireFormat === 'hybrid-json') {
      return [
        'const crypto = req' + "uire('crypto');",
        '',
        '// The hybrid-json envelope exposes each crypto field separately:',
        '//   { encryptedKey, nonce, tag, ciphertext } — all base64.',
        'function decryptHybridJson(envelope, privateKeyPem, passphrase) {',
        '  const wrappedKey = Buffer.from(envelope.encryptedKey, "base64");  // RSA-OAEP(SHA-256)(sessionKey)',
        '  const iv = Buffer.from(envelope.nonce, "base64");                 // plaintext 12-byte nonce',
        '  const tag = Buffer.from(envelope.tag, "base64");                  // plaintext 16-byte GCM tag',
        '  const ciphertext = Buffer.from(envelope.ciphertext, "base64");',
        `  // Step 1: unwrap the AES session key with ${decryptKey}.`,
        '  const sessionKey = crypto.privateDecrypt(',
        "    { key: privateKeyPem, passphrase, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },",
        '    wrappedKey,',
        '  );',
        '  // Step 2: decrypt the body with AES-256-GCM using that session key.',
        "  const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);",
        '  decipher.setAuthTag(tag);',
        '  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);',
        '}',
        '',
        '// The original content type is in `envelope.contentType` when present.',
      ].join('\n');
    }
    return [
      'const crypto = req' + "uire('crypto');",
      '',
      '// The NCR1 container already carries everything you need except the',
      '// recipient private key: the AES session key is wrapped inside wrappedKey,',
      '// and the IV + auth tag sit in plaintext right after it.',
      'function decryptNcr1(payload, privateKeyPem, passphrase) {',
      "  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'base64');",
      "  if (buf.subarray(0, 4).toString('ascii') !== 'NCR1') throw new Error('not an NCR1 container');",
      '  const wrappedLen = buf.readUInt16BE(4);',
      '  const wrappedKey = buf.subarray(6, 6 + wrappedLen);              // RSA-OAEP(SHA-256)(sessionKey)',
      '  const iv = buf.subarray(6 + wrappedLen, 18 + wrappedLen);        // plaintext 12-byte nonce',
      '  const tag = buf.subarray(18 + wrappedLen, 34 + wrappedLen);      // plaintext 16-byte GCM tag',
      '  const ciphertext = buf.subarray(34 + wrappedLen);',
      `  // Step 1: unwrap the AES session key with ${decryptKey}.`,
      '  const sessionKey = crypto.privateDecrypt(',
      "    { key: privateKeyPem, passphrase, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },",
      '    wrappedKey,',
      '  );',
      '  // Step 2: decrypt the body with AES-256-GCM using that session key.',
      "  const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);",
      '  decipher.setAuthTag(tag);',
      '  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);',
      '}',
      '',
      '// wireFormat "json": parse the body as JSON first and pass',
      '// `envelope.ciphertext` (base64) as `payload`; the original content',
      '// type is in `envelope.contentType` when present.',
    ].join('\n');
  }
  return [
    'const openpgp = req' + "uire('openpgp');",
    '',
    'async function decryptOpenPgp(payload, privateKeyArmored, passphrase) {',
    '  const privateKey = await openpgp.decryptKey({',
    '    privateKey: await openpgp.readPrivateKey({ armoredKey: privateKeyArmored }),',
    '    passphrase,',
    '  });',
    '  const message = await openpgp.readMessage({ binaryMessage: payload });',
    '  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });',
    '  return Buffer.from(data);',
    '}',
    '',
    '// Use any OpenPGP implementation; the message is a standard RFC 4880',
    '// binary message. When the route sets a verify key, check the signature',
    '// against the partner public key as well.',
  ].join('\n');
}

/**
 * Node.js snippet that encrypts the request body before sending to the
 * gateway endpoint. Direction-aware: inbound callers encrypt with the
 * gateway's RSA public key; outbound callers send plaintext (gateway encrypts).
 */
export function buildEncryptSnippet(route: UsageRoute): string {
  if (route.encryptionMode === 'aes-256-gcm') {
    if (route.wireFormat === 'hybrid-json') {
      return [
        'const crypto = req' + "uire('crypto');",
        '',
        'function encryptHybridJson(plaintext, secret) {',
        '  // secret: Buffer (32 bytes) or passphrase string',
        '  const iv = crypto.randomBytes(12);',
        '  let key, salt;',
        '  if (Buffer.isBuffer(secret) && secret.length === 32) {',
        '    key = secret;',
        '  } else {',
        '    salt = crypto.randomBytes(16);',
        '    key = crypto.scryptSync(String(secret), salt, 32);',
        '  }',
        "  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);",
        '  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);',
        '  const tag = cipher.getAuthTag();',
        '  const envelope = {',
        '    nonce: iv.toString("base64"),',
        '    tag: tag.toString("base64"),',
        '    ciphertext: ciphertext.toString("base64"),',
        '  };',
        '  if (salt) envelope.salt = salt.toString("base64");',
        '  return envelope;',
        '}',
        '',
        '// Send the returned object as the JSON body with Content-Type: application/json.',
      ].join('\n');
    }
    return [
      'const crypto = req' + "uire('crypto');",
      '',
      'function encryptNcb1(plaintext, secret) {',
      '  // secret: Buffer (32 bytes) or passphrase string',
      "  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');",
      '  const iv = crypto.randomBytes(12);',
      '  let key, header;',
      '  if (Buffer.isBuffer(secret) && secret.length === 32) {',
      '    key = secret;',
      "    header = Buffer.concat([Buffer.from('NCB1'), Buffer.from([0x00])]);",
      '  } else {',
      '    const salt = crypto.randomBytes(16);',
      '    key = crypto.scryptSync(String(secret), salt, 32);',
      "    header = Buffer.concat([Buffer.from('NCB1'), Buffer.from([0x01]), salt]);",
      '  }',
      "  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);",
      '  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);',
      '  const tag = cipher.getAuthTag();',
      '  return Buffer.concat([header, iv, tag, ciphertext]);',
      '}',
      '',
      '// wireFormat "json": wrap the container in the JSON envelope:',
      '//   { container: "NCB1", encoding: "base64", ciphertext: encryptNcb1(...).toString("base64") }',
      '// Send with Content-Type: application/octet-stream (binary) or application/json (JSON envelope).',
    ].join('\n');
  }
  if (route.encryptionMode === 'rsa-oaep') {
    const recipientKey =
      route.direction === 'inbound'
        ? "the gateway's RSA public key (route field rsaEncryptKeyName)"
        : "the partner's RSA public key (route field rsaEncryptKeyName)";
    if (route.wireFormat === 'hybrid-json') {
      return [
        'const crypto = req' + "uire('crypto');",
        '',
        `// To encrypt, wrap the AES session key with ${recipientKey}.`,
        'function encryptHybridJson(plaintext, publicKeyPem) {',
        '  // Step 1: generate a random AES-256 session key and nonce (IV).',
        '  const sessionKey = crypto.randomBytes(32);',
        '  const iv = crypto.randomBytes(12);',
        '',
        '  // Step 2: encrypt the body with AES-256-GCM.',
        "  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);",
        '  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);',
        '  const tag = cipher.getAuthTag();',
        '',
        '  // Step 3: wrap the session key with RSA-OAEP-SHA256 using the recipient public key.',
        '  const wrappedKey = crypto.publicEncrypt(',
        "    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },",
        '    sessionKey,',
        '  );',
        '',
        '  // Step 4: return the hybrid-json envelope (all fields base64).',
        '  return {',
        '    encryptedKey: wrappedKey.toString("base64"),',
        '    nonce: iv.toString("base64"),',
        '    tag: tag.toString("base64"),',
        '    ciphertext: ciphertext.toString("base64"),',
        '  };',
        '}',
        '',
        '// Send the returned object as the JSON body with Content-Type: application/json.',
      ].join('\n');
    }
    return [
      'const crypto = req' + "uire('crypto');",
      '',
      `// To encrypt, wrap the AES session key with ${recipientKey}.`,
      'function encryptNcr1(plaintext, publicKeyPem) {',
      '  // Step 1: generate a random AES-256 session key and nonce (IV).',
      '  const sessionKey = crypto.randomBytes(32);',
      '  const iv = crypto.randomBytes(12);',
      '',
      '  // Step 2: encrypt the body with AES-256-GCM.',
      "  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);",
      '  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);',
      '  const tag = cipher.getAuthTag();',
      '',
      '  // Step 3: wrap the session key with RSA-OAEP-SHA256 using the recipient public key.',
      '  const wrappedKey = crypto.publicEncrypt(',
      "    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },",
      '    sessionKey,',
      '  );',
      '',
      '  // Step 4: assemble the NCR1 container.',
      '  const lengthPrefix = Buffer.alloc(2);',
      '  lengthPrefix.writeUInt16BE(wrappedKey.length, 0);',
      '  return Buffer.concat([',
      "    Buffer.from('NCR1'),   // 4-byte magic",
      '    lengthPrefix,          // 2-byte wrapped key length',
      '    wrappedKey,            // RSA-wrapped AES session key',
      '    iv,                    // 12-byte nonce (plaintext)',
      '    tag,                   // 16-byte GCM auth tag (plaintext)',
      '    ciphertext,            // encrypted body',
      '  ]);',
      '}',
      '',
      '// wireFormat "json": wrap the container in the JSON envelope:',
      '//   { container: "NCR1", encoding: "base64", ciphertext: encryptNcr1(...).toString("base64") }',
      '// Send with Content-Type: application/octet-stream (binary) or application/json (JSON envelope).',
    ].join('\n');
  }
  return [
    'const openpgp = req' + "uire('openpgp');",
    '',
    'async function encryptOpenPgp(plaintext, recipientPublicKeyArmored) {',
    '  const publicKey = await openpgp.readKey({ armoredKey: recipientPublicKeyArmored });',
    '  const encrypted = await openpgp.encrypt({',
    '    message: await openpgp.createMessage({ binary: plaintext }),',
    '    encryptionKeys: publicKey,',
    '  });',
    '  return Buffer.from(encrypted);',
    '}',
  ].join('\n');
}

/** Canonical string + headers the caller must send when HMAC verify is on. */
export function buildHmacSigningGuide(route: UsageRoute): string {
  const tolerance = route.hmacToleranceSec ?? 300;
  return [
    'Headers to send:',
    '  X-APIM-Timestamp: <unix seconds>',
    '  X-APIM-Nonce:     <random per request, e.g. 16 bytes hex>',
    '  X-APIM-Signature: <hex HMAC-SHA256>',
    '',
    'Canonical string (join with \\n):',
    '  timestamp',
    '  nonce',
    '  METHOD (uppercase)',
    '  path + query (exactly as requested, e.g. /api/apim/inbound/orders?a=1)',
    '  sha256hex(raw request body)',
    '',
    `The timestamp must be within ${tolerance}s of the server clock; nonces cannot be replayed.`,
  ].join('\n');
}

/** What the caller must send when JWT verify is on for an inbound route. */
export function buildJwtRequirement(route: UsageRoute): string {
  const algorithm = route.jwtVerifyKeyName ? 'RS256' : 'HS256';
  const claims: string[] = [];
  if (route.jwtIssuer) claims.push(`iss = "${route.jwtIssuer}"`);
  if (route.jwtAudience) claims.push(`aud = "${route.jwtAudience}"`);
  return [
    'Send the header:  Authorization: Bearer <token>',
    `Algorithm: ${algorithm}${
      algorithm === 'RS256'
        ? ' (verified against the configured Crypto Toolkit RSA public key)'
        : ' (verified against the shared JWT secret)'
    }`,
    claims.length > 0 ? `Required claims: ${claims.join(', ')}` : 'No iss/aud constraints configured.',
  ].join('\n');
}
