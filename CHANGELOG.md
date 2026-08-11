# Changelog

All notable changes to X-Forge. Format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] — 2026-08-11

Two languages, a viewer that actually shows what was made, and a library that lives where
the operator's notes already live.

### Added

- **Ukrainian** — the console speaks English and Ukrainian, switched from a picker in the
  topbar and remembered per browser. The English string is the translation key, so an
  untranslated line renders in English instead of showing an identifier. Model slugs,
  endpoint paths and provider states stay as the provider spells them in both languages:
  translating them would break the one thing they are for, matching the API's own answers.
- **Ukrainian guidebook** — `GUIDEBOOK.uk.md` and `docs/X-Forge-Guidebook-UK.pdf`, with the
  cover, running heads and screenshots in the same language as the text. The contents list
  is regenerated from the translated headings, since GitHub anchors do not survive a
  translation.
- **The vault lives in the Obsidian vault** — assets are written to
  `/home/yuriis/Obsidian/X-FORGE/` (configurable via `FORGE_VAULT_DIR`), sorted into
  `image / video / audio / 3D / vector`, named by date and label instead of by random id,
  with a markdown note beside each file carrying the prompt, model and cost as frontmatter.
  Existing vaults migrate on first boot, once, by rename where possible.
- **Full-size viewer** — clicking a gallery tile opens it: wheel-zoom toward the pointer,
  drag-pan, `1:1`, arrow keys between assets, players for video and audio.
- **3D viewer** — GLB models render and orbit in the browser instead of being a file you
  had to open elsewhere to see.
- `npm run i18n:audit` — reports which visible strings have no translation yet, which reach
  `t` as a variable, and which dictionary entries nothing asks for any more.
- `capture-screens.mjs --lang uk` captures a second screenshot set for the translated
  guidebook.

### Changed

- The topbar date is formatted by `Intl` in the active language rather than from a table of
  English month names.
- **Creations** distinguishes what is on this machine from what is not: the local library
  shows its real path, file count and size, while folders and spaces are labelled `REMOTE`
  — they are folders in the Magnific account, not directories here.

### Fixed

- The MCP outline parser treated nested lines as top-level fields, which is why a folder
  named *Personal* appeared in the console as `WORKSPACE`.
- Panels could render empty forever under React's development double-mount: the in-flight
  guard in `useJson` was held in a ref that survived the discarded mount.
- The language provider sat inside the component that consumed it, so the shell read the
  context default and would have stayed English whatever the picker said.

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

[0.0.2]: https://github.com/yuriiss/X-Forge-Factory/releases/tag/v0.0.2
[0.0.1]: https://github.com/yuriiss/X-Forge-Factory/releases/tag/v0.0.1
