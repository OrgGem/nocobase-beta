import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, X509Certificate } from 'crypto';
import { createCsr, createSelfSigned, inspectCert, type CertSan } from '../services/cert-service';

function ed25519PrivatePem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function rsaPrivatePem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    })
    .toString();
}

function encryptedRsaPrivatePem(passphrase: string): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    })
    .toString();
}

async function externalCertViaSshpk(): Promise<string> {
  const { default: sshpk } = await import('sshpk');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const subject = sshpk.parsePrivateKey(pem, 'pem');
  const host = sshpk.Identity.forHost('cert-test.example');
  const cert = sshpk.createSelfSignedCertificate(host, subject, {
    lifetime: 365 * 24 * 3600,
    serial: Buffer.from('01', 'hex'),
  });
  return cert.toString('pem') as string;
}

function pemToDer(pemText: string): Buffer {
  const base64 = pemText
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}

// Exact DER of the CN relative distinguished name the encoder emits:
// SET { SEQUENCE { OID 2.5.4.3, UTF8String } } (test CNs are < 128 bytes).
function cnAttributeDer(commonName: string): Buffer {
  const oid = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
  const value = Buffer.concat([Buffer.from([0x0c, commonName.length]), Buffer.from(commonName, 'utf8')]);
  const seq = Buffer.concat([Buffer.from([0x30, oid.length + value.length]), oid, value]);
  return Buffer.concat([Buffer.from([0x31, seq.length]), seq]);
}

// Context-tagged GeneralName TLV: dNSName=0x82, rfc822Name=0x81, iPAddress=0x87.
function generalName(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, content.length]), content]);
}

describe('cert-service', () => {
  it('createCsr: PEM looks well-formed and contains BEGIN CERTIFICATE REQUEST', async () => {
    const { csrPem, publicKeyPem } = await createCsr({
      subject: { commonName: 'csr.example.test' },
      privateKeyPem: ed25519PrivatePem(),
    });
    expect(csrPem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----/);
    expect(publicKeyPem).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });

  it('createCsr: embeds the Common Name from the subject', async () => {
    const commonName = 'round-trip.test';
    const { csrPem } = await createCsr({
      subject: { commonName },
      privateKeyPem: ed25519PrivatePem(),
    });
    // The subject is ASN.1-encoded inside the CSR; assert the exact CN RDN bytes.
    const der = pemToDer(csrPem);
    expect(der.includes(cnAttributeDer(commonName))).toBe(true);
  });

  it('createCsr: accepts an encrypted PEM when given its passphrase', async () => {
    const { csrPem } = await createCsr({
      subject: { commonName: 'encrypted-key.test' },
      privateKeyPem: encryptedRsaPrivatePem('test-passphrase'),
      passphrase: 'test-passphrase',
    });
    expect(csrPem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----/);
  });

  it('createCsr: with SAN entries embeds DNS / IP / email GeneralNames', async () => {
    const san: CertSan = {
      dns: ['a.example.test', 'b.example.test'],
      ip: ['192.0.2.10'],
      email: ['admin@example.test'],
    };
    const { csrPem } = await createCsr({
      subject: { commonName: 'san.example.test' },
      san,
      privateKeyPem: rsaPrivatePem(),
    });
    const der = pemToDer(csrPem);
    // SubjectAlternativeName extension OID 2.5.29.17 must be present.
    expect(der.includes(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]))).toBe(true);
    for (const dns of san.dns ?? []) {
      expect(der.includes(generalName(0x82, Buffer.from(dns, 'ascii')))).toBe(true);
    }
    expect(der.includes(generalName(0x87, Buffer.from([192, 0, 2, 10])))).toBe(true);
    for (const email of san.email ?? []) {
      expect(der.includes(generalName(0x81, Buffer.from(email, 'ascii')))).toBe(true);
    }
  });

  it('createSelfSigned: emits a parsable X.509 certificate', async () => {
    const out = await createSelfSigned({
      subject: { commonName: 'self-signed.test' },
      privateKeyPem: ed25519PrivatePem(),
      validDays: 30,
    });
    expect(out.certPem).toMatch(/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/);
    expect(out.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(out.notBefore).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const before = new Date(out.notBefore).getTime();
    const after = new Date(out.notAfter).getTime();
    expect(after - before).toBeGreaterThan(28 * 24 * 60 * 60 * 1000);
    // Node can parse the cert directly.
    const node = new X509Certificate(out.certPem);
    expect(node.subject.split('=').pop()).toBe('self-signed.test');
  });

  it('createSelfSigned: validDays changes the validity window', async () => {
    const out = await createSelfSigned({
      subject: { commonName: 'window.test' },
      privateKeyPem: ed25519PrivatePem(),
      validDays: 1,
    });
    const diff = new Date(out.notAfter).getTime() - new Date(out.notBefore).getTime();
    expect(diff).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('inspectCert: round-trip data matches between create and inspect', async () => {
    const cert = await createSelfSigned({
      subject: { commonName: 'inspect-roundtrip.test' },
      san: { dns: ['cname.inspect.test'] },
      privateKeyPem: ed25519PrivatePem(),
      validDays: 60,
    });
    const info = await inspectCert(cert.certPem);
    expect(info.subject).toContain('inspect-roundtrip.test');
    expect(info.issuer).toContain('inspect-roundtrip.test'); // self-signed
    expect(info.serial).toBe('01');
    expect(info.fingerprint).toBe(cert.fingerprint);
    expect(info.sans.dns).toContain('cname.inspect.test');
    expect(info.publicKeyPem).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });

  it('inspectCert: handles an external PEM cert (created via sshpk)', async () => {
    const pem = await externalCertViaSshpk();
    const info = await inspectCert(pem);
    expect(info.subject.toLowerCase()).toContain('cert-test.example');
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('inspectCert: accepts raw DER buffer as well as PEM', async () => {
    const cert = await createSelfSigned({
      subject: { commonName: 'der-input.test' },
      privateKeyPem: ed25519PrivatePem(),
    });
    const node = new X509Certificate(cert.certPem);
    const der = node.raw;
    const info = await inspectCert(Buffer.from(der));
    expect(info.fingerprint).toBe(cert.fingerprint);
    expect(info.subject).toContain('der-input.test');
  });
});
