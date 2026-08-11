import { DatabaseSync } from "node:sqlite";
import { dbFile } from "./paths";
import { fingerprint, sealCredential } from "./secrets";
import { logger } from "./logger";

/**
 * The engine's store.
 *
 * The schema is the one in the spec, including `tenant_id` on every table and the
 * composite `UNIQUE(tenant_id, idem_key)` that §0 calls out by name: a globally unique
 * idem key is a cross-tenant hole, because two operators who write the same prompt with
 * the same model produce the same hash and the second one would be handed the first one's
 * artifact.
 *
 * SQLite via `node:sqlite` — no dependency, one file, and WAL so the worker writing job
 * transitions never blocks the UI reading them.
 */

let handle: DatabaseSync | null = null;

export const LOCAL_TENANT = "local";

export function db(): DatabaseSync {
  if (handle) return handle;
  const d = new DatabaseSync(dbFile());
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA busy_timeout = 5000");
  d.exec("PRAGMA foreign_keys = ON");
  migrate(d);
  handle = d;
  seedLocalTenant();
  return d;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS forge_tenants (
      id                  TEXT PRIMARY KEY,
      display_name        TEXT NOT NULL,
      status              TEXT NOT NULL,
      credit_floor        INTEGER NOT NULL DEFAULT 0,
      approval_threshold  INTEGER NOT NULL DEFAULT 100,
      video_enabled       INTEGER NOT NULL DEFAULT 0,
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
      rpm_limit           INTEGER NOT NULL DEFAULT 30,
      retention_days      INTEGER NOT NULL DEFAULT 30,
      created_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forge_tenant_credentials (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL REFERENCES forge_tenants(id),
      provider         TEXT NOT NULL DEFAULT 'magnific',
      ciphertext       BLOB NOT NULL,
      dek_wrapped      BLOB NOT NULL,
      key_fingerprint  TEXT NOT NULL,
      last4            TEXT NOT NULL,
      status           TEXT NOT NULL,
      last_verified_at TEXT,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forge_jobs (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL REFERENCES forge_tenants(id),
      idem_key          TEXT NOT NULL,
      client_id         TEXT,
      run_id            TEXT,
      parent_job_id     TEXT REFERENCES forge_jobs(id),

      kind              TEXT NOT NULL,
      model_id          TEXT NOT NULL,
      params_json       TEXT NOT NULL,
      prompt_version    TEXT NOT NULL,
      label             TEXT,

      status            TEXT NOT NULL,
      attempt           INTEGER NOT NULL DEFAULT 0,
      max_attempts      INTEGER NOT NULL DEFAULT 2,

      estimated_credits INTEGER,
      actual_credits    INTEGER,

      provider_task_id  TEXT,
      provider_path     TEXT,
      reservation_id    TEXT,

      error_code        TEXT,
      error_detail      TEXT,
      priority          INTEGER NOT NULL DEFAULT 100,
      not_before        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      terminal_at       TEXT,

      UNIQUE(tenant_id, idem_key)
    );
    CREATE INDEX IF NOT EXISTS forge_jobs_claim ON forge_jobs(status, priority, not_before);
    CREATE INDEX IF NOT EXISTS forge_jobs_tenant ON forge_jobs(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS forge_job_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      detail     TEXT,
      at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS forge_job_events_job ON forge_job_events(job_id, id);

    CREATE TABLE IF NOT EXISTS forge_assets (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      job_id       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      mime         TEXT NOT NULL,
      bytes        INTEGER NOT NULL,
      file_name    TEXT NOT NULL,
      source_url   TEXT,
      width        INTEGER,
      height       INTEGER,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS forge_assets_tenant ON forge_assets(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS forge_credit_reservations (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      job_id      TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      status      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      closed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS forge_res_open ON forge_credit_reservations(tenant_id, status);

    CREATE TABLE IF NOT EXISTS forge_credit_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      at         TEXT NOT NULL,
      UNIQUE(tenant_id, job_id, kind)
    );

    CREATE TABLE IF NOT EXISTS forge_balance_snapshots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  TEXT NOT NULL,
      available  INTEGER NOT NULL,
      total_plan INTEGER,
      spent      INTEGER,
      tier       TEXT,
      source     TEXT NOT NULL,
      at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS forge_balance_tenant ON forge_balance_snapshots(tenant_id, at);

    CREATE TABLE IF NOT EXISTS forge_approvals (
      job_id      TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      token_hash  TEXT NOT NULL,
      reason      TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      decision    TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forge_rate_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      at_ms     INTEGER NOT NULL,
      scope     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS forge_rate_at ON forge_rate_events(at_ms);

    CREATE TABLE IF NOT EXISTS forge_kv (
      tenant_id TEXT NOT NULL,
      k         TEXT NOT NULL,
      v         TEXT NOT NULL,
      at        TEXT NOT NULL,
      PRIMARY KEY (tenant_id, k)
    );
  `);
}

/**
 * The console runs for one operator with the key already in their environment, so the
 * local tenant is created on first boot and the env key is sealed into the credential
 * table like any other. It gets no special path through the engine: budget checks,
 * reservations and redaction all apply to it, which is the only way those code paths are
 * ever actually exercised.
 */
function seedLocalTenant(): void {
  const d = handle!;
  const now = new Date().toISOString();
  const existing = d.prepare("SELECT id FROM forge_tenants WHERE id = ?").get(LOCAL_TENANT);
  if (!existing) {
    d.prepare(
      `INSERT INTO forge_tenants (id, display_name, status, credit_floor, approval_threshold,
        video_enabled, max_concurrent_jobs, rpm_limit, retention_days, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      LOCAL_TENANT,
      "Operator",
      Number(process.env.FORGE_CREDIT_FLOOR ?? 0),
      Number(process.env.FORGE_APPROVAL_THRESHOLD ?? 400),
      process.env.FORGE_VIDEO_ENABLED === "1" ? 1 : 0,
      Number(process.env.FORGE_MAX_CONCURRENT ?? 3),
      Number(process.env.FORGE_RPM_LIMIT ?? 30),
      Number(process.env.FORGE_RETENTION_DAYS ?? 30),
      now,
    );
    logger.info("db", "created local tenant");
  }

  const envKey = (process.env.MAGNIFIC_API_KEY || "").trim();
  if (!envKey) return;
  const fp = fingerprint(envKey);
  const cred = d
    .prepare("SELECT id, key_fingerprint FROM forge_tenant_credentials WHERE tenant_id = ? AND provider = 'magnific'")
    .get(LOCAL_TENANT) as { id: string; key_fingerprint: string } | undefined;
  if (cred?.key_fingerprint === fp) return;

  const sealed = sealCredential(envKey);
  d.prepare("DELETE FROM forge_tenant_credentials WHERE tenant_id = ? AND provider = 'magnific'").run(LOCAL_TENANT);
  d.prepare(
    `INSERT INTO forge_tenant_credentials (id, tenant_id, provider, ciphertext, dek_wrapped,
       key_fingerprint, last4, status, created_at)
     VALUES (?, ?, 'magnific', ?, ?, ?, ?, 'active', ?)`,
  ).run(
    `cred_${Date.now().toString(36)}`,
    LOCAL_TENANT,
    sealed.ciphertext,
    sealed.dekWrapped,
    sealed.fingerprint,
    sealed.last4,
    now,
  );
  logger.info("db", `sealed magnific credential ending ${sealed.last4}`);
}

/** ULID-ish: time-ordered, random tail. Sorting by id sorts by creation. */
export function newId(prefix = ""): string {
  const t = Date.now().toString(36).padStart(9, "0").toUpperCase();
  const r = Math.random().toString(36).slice(2, 12).toUpperCase();
  return `${prefix}${t}${r}`;
}
