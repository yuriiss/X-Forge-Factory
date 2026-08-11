import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Envelope encryption for provider credentials (spec §2.2).
 *
 * A per-tenant DEK encrypts the key; the master key — from the environment, never the
 * database and never the repository — encrypts the DEK. Rotating the master key therefore
 * means re-wrapping DEKs, not re-encrypting every secret, which is what makes rotation
 * possible without downtime (requirement 7).
 *
 * AES-256-GCM both times: the auth tag is what turns "the ciphertext decrypted to
 * something" into "the ciphertext is the one we wrote".
 */

function masterKey(): Buffer {
  const raw = (process.env.FORGE_MASTER_KEY || "").trim();
  if (!raw) throw new Error("FORGE_MASTER_KEY is not set — refusing to store credentials unencrypted");
  // Hex of 32 bytes is the intended form; anything else is hashed to the right length so a
  // passphrase works too rather than silently truncating.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw).digest();
}

function seal(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function open(blob: Buffer, key: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export interface SealedCredential {
  ciphertext: Buffer;
  dekWrapped: Buffer;
  fingerprint: string;
  last4: string;
}

export function sealCredential(apiKey: string): SealedCredential {
  const dek = randomBytes(32);
  return {
    ciphertext: seal(Buffer.from(apiKey, "utf8"), dek),
    dekWrapped: seal(dek, masterKey()),
    fingerprint: fingerprint(apiKey),
    last4: apiKey.slice(-4),
  };
}

/**
 * Decrypt in memory, at the moment of the outbound call, and nowhere else (requirement 2).
 * The plaintext is never returned to a route handler — callers get it inside `use`, which
 * is a closure the value cannot outlive by accident.
 */
export function useCredential<T>(row: { ciphertext: Buffer; dek_wrapped: Buffer }, use: (key: string) => T): T {
  const dek = open(Buffer.from(row.dek_wrapped), masterKey());
  const key = open(Buffer.from(row.ciphertext), dek).toString("utf8");
  try {
    return use(key);
  } finally {
    dek.fill(0);
  }
}

export function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Re-wrap a DEK under a new master key. Used by the rotation script (requirement 7). */
export function rewrapDek(dekWrapped: Buffer, oldMaster: Buffer, newMaster: Buffer): Buffer {
  const dek = open(Buffer.from(dekWrapped), oldMaster);
  const out = seal(dek, newMaster);
  dek.fill(0);
  return out;
}

export function masterKeyFrom(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw).digest();
}
