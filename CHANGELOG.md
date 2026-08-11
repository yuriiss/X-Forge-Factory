# Changelog

All notable changes to X-Forge. Format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] — 2026-08-11

First public release. Sixteen screens, two live surfaces, and a job engine that treats
someone else's credits as if they were someone else's credits.

### Console

- **Dashboard** — live balance, the console's own outbound rate meters, job queue, service
  health and the vault's most recent output.
- **Image Forge** — Mystic, FLUX and Seedream on the REST key with their full parameter
  sets (references, LoRAs, engines, creative detailing), plus the entire 48-model catalogue
  over MCP.
- **Video Forge** — the 52-model catalogue, text- and image-to-video, `video_plan` before
  spending, per-model pricing before submit.
- **Audio Lab** — music, sound effects and SAM isolation on REST; text-to-speech over MCP
  against the ~600-voice catalogue; stock music and SFX search.
- **3D & Soul** — image-to-GLB, Soul reference training, and every trained reference from
  both the REST LoRA store and the MCP Library.
- **Icon Foundry** — text-to-SVG generation beside a search of Magnific's finished vectors.
- **Upscale Studio** — Creative, Precision, Precision V2 and Skin Enhancer, with the source
  pickable straight from the vault and the provider's own cost range shown first.
- **Edit Suite** — relight, expand, cutout, reimagine, change camera, retouch, vectorise and
  smart crop, across both execution paths.
- **Flows** — published Spaces pipelines with forms built from each flow's declared inputs.
- **Task Queue** — every job in its real state, with per-job transition history, cancel and
  reconcile.
- **Creations** — the local vault and the account's own history, side by side and clearly
  labelled, plus a three-way importer.
- **Stock** — images, videos, music, sound effects and icons.
- **Utilities** — image-to-prompt, prompt improver, AI classifier.
- **MCP Console** — live `tools/list`, argument forms generated from each tool's JSON schema,
  and a caller that prices credit-spending tools before running them.
- **Analytics** — the engine's own ledger, outcome mix and audit trail.
- **Developers** — credential management, engine limits, webhook receiver with a verification
  record, staging area and the reconciler.

### Engine

- Tenant-scoped repository layer; a call without a tenant in context throws rather than
  running. `tenant_id` supplied by a request is ignored.
- Envelope-encrypted credentials — per-tenant DEK, master key from the environment, master
  key rotation without re-encrypting ciphertext.
- Central log redaction, with a test that logs a key deliberately and asserts the output.
- Credit reservations and a ledger written exactly once, in the transaction that closes the
  reservation.
- Approval gate: anything over the threshold, or with a price the provider will not quote,
  produces a one-time fifteen-minute link. No API endpoint and no MCP tool can lift it.
- `needs_recon` instead of retrying after contact is lost post-submission, with a
  reconciler that adopts completed work rather than regenerating it.
- Per-tenant and global outbound rate shaping, with poll intervals that back off as a job
  ages.
- Pricing from Magnific's own `simulate_cost` rather than a table in this repository.

### Tooling

- `npm run setup` — interactive first run; generates the master key and verifies the API key
  against the live API before writing anything.
- 34 unit tests, 24 live API tests, 4 browser tests.
- `scripts/capability-sweep.mjs` — runs every capability once, on the cheapest setting that
  proves the path, and reports what worked and what it cost.
- `GUIDEBOOK.md` and a 27-page PDF built from it with `npm run docs`.

### Notes

Established against the live API and pinned by tests, because the published reference does
not mention them: video endpoints spell aspect ratios out and take `duration` as a string;
`kling-v2-6-pro` has no status route and is therefore reached over MCP; image-to-video
refuses base64; `improve-prompt` requires an undocumented `type`; the MCP list tools answer
in an indented outline rather than JSON; `simulate_cost` takes different arguments from the
tool it prices; background removal serves PNG as `application/octet-stream`.

[0.0.1]: https://github.com/yuriiss/X-Forge-Factory/releases/tag/v0.0.1
