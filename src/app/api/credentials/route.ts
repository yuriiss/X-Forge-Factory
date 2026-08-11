import { body, handle } from "@/lib/server/http";
import { credentialStatus, markCredentialVerified, revokeCredential } from "@/lib/server/repo";
import { verifyKey } from "@/lib/server/magnific";
import { db, LOCAL_TENANT, newId } from "@/lib/server/db";
import { sealCredential } from "@/lib/server/secrets";
import { logger } from "@/lib/server/logger";

export const dynamic = "force-dynamic";

/**
 * The credential, described but never revealed.
 *
 * The key never leaves the server: this endpoint answers with `last4`, a truncated
 * fingerprint and when it was last verified, and there is no endpoint anywhere that
 * returns the key itself (spec §2.2 requirement 3).
 */
export async function GET() {
  return handle(async (ctx) => ({ credential: credentialStatus(ctx) }));
}

/** Store a key — after proving it works. An invalid key is not saved (requirement 5). */
export async function POST(req: Request) {
  return handle(async (ctx) => {
    const { key } = await body<{ key?: string }>(req);
    const trimmed = (key ?? "").trim();
    if (trimmed.length < 12) throw new Error("that does not look like a Magnific API key");

    const sealed = sealCredential(trimmed);
    const id = newId("cred_");
    const now = new Date().toISOString();
    const d = db();

    // Written first so the verification call can use the normal path — then rolled back if
    // the provider rejects it, which leaves no unverified key behind.
    const previous = d
      .prepare("SELECT id, ciphertext, dek_wrapped, key_fingerprint, last4, status, created_at FROM forge_tenant_credentials WHERE tenant_id = ?")
      .all(LOCAL_TENANT) as unknown as {
      id: string;
      ciphertext: Uint8Array;
      dek_wrapped: Uint8Array;
      key_fingerprint: string;
      last4: string;
      status: string;
      created_at: string;
    }[];
    d.prepare("DELETE FROM forge_tenant_credentials WHERE tenant_id = ?").run(LOCAL_TENANT);
    d.prepare(
      `INSERT INTO forge_tenant_credentials (id, tenant_id, provider, ciphertext, dek_wrapped, key_fingerprint, last4, status, created_at)
       VALUES (?, ?, 'magnific', ?, ?, ?, ?, 'active', ?)`,
    ).run(id, LOCAL_TENANT, sealed.ciphertext, sealed.dekWrapped, sealed.fingerprint, sealed.last4, now);

    const good = await verifyKey(ctx).catch(() => false);
    if (!good) {
      d.prepare("DELETE FROM forge_tenant_credentials WHERE id = ?").run(id);
      for (const row of previous) {
        d.prepare(
          `INSERT INTO forge_tenant_credentials (id, tenant_id, provider, ciphertext, dek_wrapped, key_fingerprint, last4, status, created_at)
           VALUES (?, ?, 'magnific', ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, LOCAL_TENANT, row.ciphertext, row.dek_wrapped, row.key_fingerprint, row.last4, row.status, row.created_at);
      }
      throw new Error("Magnific rejected that key — nothing was saved");
    }

    markCredentialVerified(ctx);
    logger.info("credentials", `stored a verified key ending ${sealed.last4}`);
    return { credential: credentialStatus(ctx) };
  });
}

/** Revoke: the ciphertext goes now, and queued work goes with it (requirement 6). */
export async function DELETE() {
  return handle(async (ctx) => {
    revokeCredential(ctx);
    return { credential: credentialStatus(ctx) };
  });
}
