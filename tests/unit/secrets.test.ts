import { describe, expect, it } from "vitest";
import { fingerprint, masterKeyFrom, rewrapDek, sealCredential, useCredential } from "@/lib/server/secrets";
import { redact, recentLogs, logger } from "@/lib/server/logger";

/**
 * Spec §2.2 and its acceptance criteria: the key is never readable from anything we store
 * or print, and rotating the master key does not lose access to what was sealed under the
 * old one.
 */
describe("credential sealing", () => {
  const KEY = "FPSXsecretkeyvalue1234567890abcdef";

  it("round-trips through the envelope", () => {
    const sealed = sealCredential(KEY);
    const out = useCredential({ ciphertext: sealed.ciphertext, dek_wrapped: sealed.dekWrapped }, (k) => k);
    expect(out).toBe(KEY);
  });

  it("never stores the key in the clear", () => {
    const sealed = sealCredential(KEY);
    expect(sealed.ciphertext.toString("utf8")).not.toContain(KEY);
    expect(sealed.ciphertext.toString("base64")).not.toContain(Buffer.from(KEY).toString("base64"));
    expect(sealed.last4).toBe(KEY.slice(-4));
    expect(sealed.fingerprint).toBe(fingerprint(KEY));
  });

  it("refuses a tampered ciphertext instead of returning garbage", () => {
    const sealed = sealCredential(KEY);
    sealed.ciphertext[40] ^= 0xff;
    expect(() => useCredential({ ciphertext: sealed.ciphertext, dek_wrapped: sealed.dekWrapped }, (k) => k)).toThrow();
  });

  it("survives a master key rotation (acceptance §9)", () => {
    const sealed = sealCredential(KEY);
    const oldMaster = masterKeyFrom(process.env.FORGE_MASTER_KEY!);
    const newMaster = masterKeyFrom("b".repeat(64));

    const rewrapped = rewrapDek(sealed.dekWrapped, oldMaster, newMaster);
    process.env.FORGE_MASTER_KEY = "b".repeat(64);
    try {
      const out = useCredential({ ciphertext: sealed.ciphertext, dek_wrapped: rewrapped }, (k) => k);
      expect(out).toBe(KEY);
    } finally {
      process.env.FORGE_MASTER_KEY = "a".repeat(64);
    }
  });
});

/**
 * The spec asks for a test that writes a key to the log ON PURPOSE and proves the output
 * is redacted — because "we are careful not to log it" is not a control.
 */
describe("log redaction", () => {
  it("redacts a key that a caller deliberately logs", () => {
    const key = process.env.MAGNIFIC_API_KEY!;
    logger.info("test", `about to leak ${key} in a message`);
    const line = recentLogs(5).find((l) => l.scope === "test");
    expect(line).toBeTruthy();
    expect(line!.message).not.toContain(key);
    expect(line!.message).toContain("[REDACTED]");
  });

  it("redacts bearer tokens, JWTs and signing secrets", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789")).toContain("[REDACTED]");
    expect(redact("eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSM")).toContain("[REDACTED]");
    expect(redact(`secret is ${process.env.MAGNIFIC_WEBHOOK_SECRET}`)).not.toContain("testsecret");
  });

  it("redacts a key nested inside an object", () => {
    const out = redact({ headers: { "x-magnific-api-key": process.env.MAGNIFIC_API_KEY } });
    expect(out).not.toContain(process.env.MAGNIFIC_API_KEY!);
  });
});
