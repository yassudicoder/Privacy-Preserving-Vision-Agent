import { describe, expect, it } from 'vitest';
import {
  charClassOf,
  dedupeMatches,
  ipv4Valid,
  luhnValid,
  panValid,
  scanTextPatterns,
  ssnValid,
  verhoeffValid,
} from '@/redaction/index.ts';

describe('checksums', () => {
  it('accepts Luhn-valid card numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4012888888881881')).toBe(true);
    expect(luhnValid('5500005555555559')).toBe(true);
  });

  it('rejects a 16-digit number that is not Luhn-valid', () => {
    // This is the whole reason the validator exists: a digit-counting regex
    // would call this a card number and blow precision on every order page.
    expect(luhnValid('1234567890123456')).toBe(false);
  });

  it('rejects card numbers of implausible length', () => {
    expect(luhnValid('411111111')).toBe(false);
    expect(luhnValid('41111111111111111111')).toBe(false);
  });

  it('accepts Verhoeff-valid Aadhaar numbers', () => {
    expect(verhoeffValid('234567890124')).toBe(true);
    expect(verhoeffValid('345678901238')).toBe(true);
  });

  it('rejects Aadhaar numbers with a bad check digit', () => {
    expect(verhoeffValid('234567890123')).toBe(false);
    expect(verhoeffValid('234567890125')).toBe(false);
  });

  it('rejects Aadhaar of the wrong length', () => {
    expect(verhoeffValid('23456789012')).toBe(false);
    expect(verhoeffValid('2345678901245')).toBe(false);
  });

  it('does not confuse the two checksum schemes', () => {
    // A Verhoeff-valid Aadhaar is not Luhn-valid, and vice versa. Using the
    // wrong one silently misses an entire class of identifier.
    expect(luhnValid('234567890124')).toBe(false);
  });

  it('validates PAN structure including the holder-type character', () => {
    expect(panValid('ABCPD1234E')).toBe(true);
    // 4th character 'Z' is not a recognised holder type.
    expect(panValid('ABCZD1234E')).toBe(false);
    expect(panValid('ABCP12345E')).toBe(false);
  });

  it('validates IPv4 octet ranges', () => {
    expect(ipv4Valid('192.168.1.1')).toBe(true);
    expect(ipv4Valid('255.255.255.255')).toBe(true);
    expect(ipv4Valid('256.1.1.1')).toBe(false);
    expect(ipv4Valid('1.2.3')).toBe(false);
  });

  it('rejects SSNs with never-issued prefixes', () => {
    expect(ssnValid('123-45-6789')).toBe(true);
    expect(ssnValid('000-45-6789')).toBe(false);
    expect(ssnValid('666-45-6789')).toBe(false);
    expect(ssnValid('900-45-6789')).toBe(false);
  });
});

describe('scanTextPatterns', () => {
  it('finds an email', () => {
    const found = scanTextPatterns('write to priya.sharma@example.com today');
    expect(found.map((m) => m.kind)).toContain('email');
    expect(found.find((m) => m.kind === 'email')?.value).toBe('priya.sharma@example.com');
  });

  it('finds a Luhn-valid card and gives it high confidence', () => {
    const found = scanTextPatterns('card 4111111111111111 on file');
    const card = found.find((m) => m.kind === 'credit-card');
    expect(card).toBeDefined();
    expect(card?.confidence).toBeGreaterThan(0.9);
  });

  it('does NOT report a Luhn-invalid 16-digit number as a card', () => {
    const found = scanTextPatterns('order reference 1234567890123456');
    expect(found.some((m) => m.kind === 'credit-card')).toBe(false);
  });

  it('finds a Verhoeff-valid Aadhaar', () => {
    const found = scanTextPatterns('Aadhaar 234567890124 verified');
    const aadhaar = found.find((m) => m.kind === 'aadhaar');
    expect(aadhaar).toBeDefined();
    expect(aadhaar?.confidence).toBeGreaterThan(0.9);
  });

  it('does not report a checksum-failing 12-digit number as Aadhaar', () => {
    const found = scanTextPatterns('reference 234567890123 logged');
    expect(found.some((m) => m.kind === 'aadhaar')).toBe(false);
  });

  it('finds an Indian mobile number', () => {
    const found = scanTextPatterns('call 9876543210 for help');
    expect(found.some((m) => m.kind === 'phone')).toBe(true);
  });

  it('finds prefixed API keys', () => {
    const found = scanTextPatterns('token AKIAIOSFODNN7EXAMPLE rotated');
    expect(found.some((m) => m.kind === 'api-key')).toBe(true);
  });

  it('returns nothing for genuinely benign prose', () => {
    const found = scanTextPatterns(
      'Slew rates are limited by the elevation drive. Refer to the maintenance chapter.',
      0.5,
    );
    expect(found).toEqual([]);
  });

  it('reports spans that index back into the source text', () => {
    const text = 'mail me at a@b.co ok';
    const found = scanTextPatterns(text);
    const email = found.find((m) => m.kind === 'email');
    expect(email).toBeDefined();
    if (email !== undefined) {
      expect(text.slice(email.start, email.end)).toBe(email.value);
    }
  });

  it('is not order-dependent across repeated scans', () => {
    // The rule bank uses /g literals; a shared lastIndex would make the second
    // call return different results from the first.
    const text = 'a@b.co and 4111111111111111';
    expect(scanTextPatterns(text)).toEqual(scanTextPatterns(text));
  });
});

describe('dedupeMatches', () => {
  it('prefers the higher-confidence match when spans overlap', () => {
    const kept = dedupeMatches([
      { kind: 'bank-account', rule: 'account-long-digits', start: 0, end: 16, value: 'x', confidence: 0.3 },
      { kind: 'credit-card', rule: 'luhn-credit-card', start: 0, end: 16, value: 'x', confidence: 0.97 },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.kind).toBe('credit-card');
  });

  it('keeps non-overlapping matches', () => {
    const kept = dedupeMatches([
      { kind: 'email', rule: 'email-rfc-lite', start: 0, end: 5, value: 'a', confidence: 0.9 },
      { kind: 'phone', rule: 'phone-in-e164', start: 10, end: 20, value: 'b', confidence: 0.8 },
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe('charClassOf', () => {
  it('classifies value shapes', () => {
    expect(charClassOf('123456')).toBe('numeric');
    expect(charClassOf('abcdef')).toBe('alpha');
    expect(charClassOf('abc123')).toBe('alphanumeric');
    expect(charClassOf('a b-c')).toBe('mixed');
    expect(charClassOf('')).toBe('unknown');
  });
});
