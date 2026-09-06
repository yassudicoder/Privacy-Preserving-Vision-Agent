/**
 * Non-cryptographic, salted hashing for redaction-log evidence.
 *
 * The log is written to disk and rendered in the panel, so it must never contain
 * the PII it describes. A salted hash lets us dedupe and correlate detections
 * across frames without keeping the value. The salt is per session and never
 * leaves the client, so the hashes are not comparable across sessions and
 * cannot be rainbow-tabled back into values.
 *
 * FNV-1a is fine here: this is a correlation key, not an authentication tag.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(input: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Hex digest of `salt + value`. Stable for a given salt. */
export function saltedHash(value: string, salt: string): string {
  return fnv1a(`${salt}:${value}`).toString(16).padStart(8, '0');
}

/**
 * A fresh, unguessable-enough session salt. Uses crypto.getRandomValues where
 * available (browser, Node 20+) and refuses to silently fall back to Math.random.
 */
export function newSessionSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fixed salt for deterministic tests. Never use outside tests. */
export const TEST_SALT = 'test-salt-do-not-use-in-production';
