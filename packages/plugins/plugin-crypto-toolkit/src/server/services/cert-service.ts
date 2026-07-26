import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  sign as signOneShot,
  type KeyObject,
} from 'crypto';
import { isIP } from 'net';

export interface CertSubject {
  commonName?: string;
  organization?: string;
  organizationalUnit?: string;
  country?: string;
  state?: string;
  locality?: string;
  email?: string;
}

export interface CertSan {
  dns?: string[];
  ip?: string[];
  email?: string[];
}

export interface CreateCsrInput {
  subject: CertSubject;
  san?: CertSan;
  /** PKCS#8 PEM of the private key that the CSR will attest to. */
  privateKeyPem: string;
  /** Passphrase for an encrypted PEM private key. */
  passphrase?: string;
  /** Optional hash algorithm; defaults to SHA-256. */
  hash?: 'SHA-256' | 'SHA-384' | 'SHA-512';
}

export interface CreateCsrResult {
  csrPem: string;
  publicKeyPem: string;
}

export interface CreateSelfSignedInput extends CreateCsrInput {
  /** Lifetime in days (default 365). */
  validDays?: number;
}

export interface CreateSelfSignedResult {
  certPem: string;
  fingerprint: string;
  notBefore: string;
  notAfter: string;
}

export interface InspectCertResult {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  sans: { dns: string[]; ip: string[]; email: string[] };
  keyAlgorithm: string;
  signatureAlgorithm: string;
  fingerprint: string;
  publicKeyPem: string;
}

type HashName = 'sha256' | 'sha384' | 'sha512';
type SupportedKeyType = 'ed25519' | 'rsa';

const SUBJECT_ATTRIBUTES: Array<[keyof CertSubject, string, number]> = [
  ['commonName', '2.5.4.3', 0x0c],
  ['organization', '2.5.4.10', 0x0c],
  ['organizationalUnit', '2.5.4.11', 0x0c],
  ['country', '2.5.4.6', 0x13],
  ['state', '2.5.4.8', 0x0c],
  ['locality', '2.5.4.7', 0x0c],
  ['email', '1.2.840.113549.1.9.1', 0x16],
];

const RSA_SIGNATURE_OIDS: Record<HashName, string> = {
  sha256: '1.2.840.113549.1.1.11',
  sha384: '1.2.840.113549.1.1.12',
  sha512: '1.2.840.113549.1.1.13',
};

function der(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 128) return Buffer.concat([Buffer.from([tag, length]), content]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return der(0x31, Buffer.concat(parts));
}

function objectIdentifier(value: string): Buffer {
  const values = value.split('.').map((part) => Number(part));
  if (values.length < 2 || values.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid object identifier: ${value}`);
  }
  const encoded: number[] = [values[0] * 40 + values[1]];
  for (const valuePart of values.slice(2)) {
    const chunks = [valuePart & 0x7f];
    for (let current = valuePart >> 7; current > 0; current >>= 7) chunks.unshift(0x80 | (current & 0x7f));
    encoded.push(...chunks);
  }
  return der(0x06, Buffer.from(encoded));
}

function integer(value: number | Buffer): Buffer {
  let body: Buffer;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('DER integer must be a non-negative safe integer');
    const bytes: number[] = [];
    do {
      bytes.unshift(value & 0xff);
      value >>= 8;
    } while (value > 0);
    body = Buffer.from(bytes);
  } else {
    body = Buffer.from(value);
  }
  if (body.length === 0) body = Buffer.from([0]);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return der(0x02, body);
}

function nullValue(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function bitString(value: Buffer): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function octetString(value: Buffer): Buffer {
  return der(0x04, value);
}

function stringValue(value: string, tag: number): Buffer {
  return der(tag, Buffer.from(value, 'utf8'));
}

function utcTime(value: Date): Buffer {
  const two = (number: number) => String(number).padStart(2, '0');
  const four = (number: number) => String(number).padStart(4, '0');
  const year = value.getUTCFullYear();
  const body =
    year >= 1950 && year < 2050
      ? `${two(year % 100)}${two(value.getUTCMonth() + 1)}${two(value.getUTCDate())}${two(value.getUTCHours())}${two(
          value.getUTCMinutes(),
        )}${two(value.getUTCSeconds())}Z`
      : `${four(year)}${two(value.getUTCMonth() + 1)}${two(value.getUTCDate())}${two(value.getUTCHours())}${two(
          value.getUTCMinutes(),
        )}${two(value.getUTCSeconds())}Z`;
  return stringValue(body, year >= 1950 && year < 2050 ? 0x17 : 0x18);
}

function subjectName(subject: CertSubject): Buffer {
  const normalized: CertSubject = { ...subject, commonName: subject.commonName || 'nocobase-crypto-toolkit' };
  const attributes = SUBJECT_ATTRIBUTES.flatMap(([field, oid, tag]) => {
    const value = normalized[field];
    return value ? [set(sequence(objectIdentifier(oid), stringValue(value, tag)))] : [];
  });
  return sequence(...attributes);
}

function ipv6Buffer(value: string): Buffer {
  const parts = value.toLowerCase().split('::');
  if (parts.length > 2) throw new Error(`Invalid IPv6 address: ${value}`);
  const parseSide = (side: string) => (side ? side.split(':').filter(Boolean) : []);
  const head = parseSide(parts[0]);
  const tail = parseSide(parts[1] ?? '');
  const expandIPv4 = (groups: string[]) => {
    const last = groups.at(-1);
    if (!last || !last.includes('.')) return groups;
    const ipv4 = Buffer.from(last.split('.').map(Number));
    groups.splice(-1, 1, ipv4.readUInt16BE(0).toString(16), ipv4.readUInt16BE(2).toString(16));
    return groups;
  };
  expandIPv4(head);
  expandIPv4(tail);
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) throw new Error(`Invalid IPv6 address: ${value}`);
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => {
    const parsed = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || !Number.isInteger(parsed)) throw new Error(`Invalid IPv6 address: ${value}`);
    result.writeUInt16BE(parsed, index * 2);
  });
  return result;
}

function ipBuffer(value: string): Buffer {
  const family = isIP(value);
  if (family === 4) return Buffer.from(value.split('.').map(Number));
  if (family === 6) return ipv6Buffer(value);
  throw new Error(`Invalid IP address: ${value}`);
}

function subjectAltNameExtension(san: CertSan | undefined): Buffer | undefined {
  if (!san) return undefined;
  const names = [
    ...(san.dns ?? []).map((value) => der(0x82, Buffer.from(value, 'ascii'))),
    ...(san.ip ?? []).map((value) => der(0x87, ipBuffer(value))),
    ...(san.email ?? []).map((value) => der(0x81, Buffer.from(value, 'ascii'))),
  ];
  if (names.length === 0) return undefined;
  return sequence(objectIdentifier('2.5.29.17'), octetString(sequence(...names)));
}

function csrAttributes(san: CertSan | undefined): Buffer {
  const extension = subjectAltNameExtension(san);
  if (!extension) return der(0xa0, Buffer.alloc(0));
  const extensions = sequence(extension);
  const extensionRequest = sequence(objectIdentifier('1.2.840.113549.1.9.14'), set(extensions));
  return der(0xa0, extensionRequest);
}

function normalizeHash(hash: CreateCsrInput['hash']): HashName {
  switch (hash ?? 'SHA-256') {
    case 'SHA-256':
      return 'sha256';
    case 'SHA-384':
      return 'sha384';
    case 'SHA-512':
      return 'sha512';
  }
}

function keyType(key: KeyObject): SupportedKeyType {
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'rsa') return 'rsa';
  throw new Error(
    `Certificates support RSA and Ed25519 keys only; received ${key.asymmetricKeyType ?? 'an unsupported key type'}`,
  );
}

function signatureAlgorithm(type: SupportedKeyType, hash: HashName): Buffer {
  return type === 'ed25519'
    ? sequence(objectIdentifier('1.3.101.112'))
    : sequence(objectIdentifier(RSA_SIGNATURE_OIDS[hash]), nullValue());
}

function signDer(content: Buffer, privateKey: KeyObject, type: SupportedKeyType, hash: HashName): Buffer {
  if (type === 'ed25519') return signOneShot(null, content, privateKey);
  const signer = createSign(hash);
  signer.update(content);
  signer.end();
  return signer.sign(privateKey);
}

function pem(label: string, derValue: Buffer): string {
  const body =
    derValue
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function privateKeyFromInput(input: CreateCsrInput): KeyObject {
  return createPrivateKey(
    input.passphrase ? { key: input.privateKeyPem, passphrase: input.passphrase } : input.privateKeyPem,
  );
}

function parseSubjectAltName(value: string | undefined): InspectCertResult['sans'] {
  const sans = { dns: [] as string[], ip: [] as string[], email: [] as string[] };
  if (!value) return sans;
  for (const item of value.split(/,\s*/)) {
    if (item.startsWith('DNS:')) sans.dns.push(item.slice(4));
    else if (item.startsWith('IP Address:')) sans.ip.push(item.slice('IP Address:'.length));
    else if (item.toLowerCase().startsWith('email:')) sans.email.push(item.slice(item.indexOf(':') + 1));
  }
  return sans;
}

export async function createCsr(input: CreateCsrInput): Promise<CreateCsrResult> {
  const privateKey = privateKeyFromInput(input);
  const publicKey = createPublicKey(privateKey);
  const type = keyType(privateKey);
  const hash = normalizeHash(input.hash);
  const certificationRequestInfo = sequence(
    integer(0),
    subjectName(input.subject),
    publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
    csrAttributes(input.san),
  );
  const signature = signDer(certificationRequestInfo, privateKey, type, hash);
  const csrDer = sequence(certificationRequestInfo, signatureAlgorithm(type, hash), bitString(signature));
  return {
    csrPem: pem('CERTIFICATE REQUEST', csrDer),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

export async function createSelfSigned(input: CreateSelfSignedInput): Promise<CreateSelfSignedResult> {
  const privateKey = privateKeyFromInput(input);
  const publicKey = createPublicKey(privateKey);
  const type = keyType(privateKey);
  const hash = normalizeHash(input.hash);
  const notBefore = new Date();
  const validDays = input.validDays ?? 365;
  if (!Number.isFinite(validDays) || validDays <= 0) throw new Error('validDays must be a positive number');
  const notAfter = new Date(notBefore.getTime() + validDays * 24 * 60 * 60 * 1000);
  const name = subjectName(input.subject);
  const extension = subjectAltNameExtension(input.san);
  const extensions = extension ? der(0xa3, sequence(extension)) : Buffer.alloc(0);
  const tbsCertificate = sequence(
    der(0xa0, integer(2)),
    integer(Buffer.from([1])),
    signatureAlgorithm(type, hash),
    name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
    extensions,
  );
  const signature = signDer(tbsCertificate, privateKey, type, hash);
  const certDer = sequence(tbsCertificate, signatureAlgorithm(type, hash), bitString(signature));
  return {
    certPem: pem('CERTIFICATE', certDer),
    fingerprint: createHash('sha256').update(certDer).digest('hex'),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
  };
}

export async function inspectCert(material: string | Buffer): Promise<InspectCertResult> {
  const nodeCert = new X509Certificate(material);
  const derValue = nodeCert.raw;
  return {
    subject: nodeCert.subject,
    issuer: nodeCert.issuer,
    serial: nodeCert.serialNumber,
    notBefore: new Date(nodeCert.validFrom).toISOString(),
    notAfter: new Date(nodeCert.validTo).toISOString(),
    sans: parseSubjectAltName(nodeCert.subjectAltName),
    keyAlgorithm: nodeCert.publicKey.asymmetricKeyType ?? '',
    signatureAlgorithm: nodeCert.signatureAlgorithm,
    fingerprint: createHash('sha256').update(derValue).digest('hex'),
    publicKeyPem: nodeCert.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}
