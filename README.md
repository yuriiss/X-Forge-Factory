<div align="center">

# ◆ X-FORGE

**An operator console for Magnific — every capability on one surface, with an engine that
treats credits like money.**

[![version](https://img.shields.io/badge/version-0.0.4-e8b64c?style=flat-square)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-AGPL--3.0-3d4757?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-4ade80?style=flat-square)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-3d4757?style=flat-square)](#requirements)
[![next](https://img.shields.io/badge/Next.js-16-0d1322?style=flat-square)](https://nextjs.org)
[![tests](https://img.shields.io/badge/tests-108%20passing-4ade80?style=flat-square)](#tests)
[![guidebook](https://img.shields.io/badge/guidebook-31%20pages-e8b64c?style=flat-square)](GUIDEBOOK.md)
[![languages](https://img.shields.io/badge/languages-EN%20%C2%B7%20UA-7fd4cb?style=flat-square)](GUIDEBOOK.uk.md)

<img src="docs/images/dashboard.png" alt="X-Forge dashboard" width="100%">

</div>

---

X-Forge talks to Magnific over **both** of its surfaces at once: the REST API at
`api.magnific.com` with your own key, and the MCP server at `mcp.magnific.com` over OAuth.
Between them you reach the full catalogue — 48 image models, 52 video models, ~600 voices,
88 MCP tools — instead of the handful any single surface exposes.

Behind the seventeen screens sits a job engine built to a specification rather than to a demo:
credits are reserved before work starts, charged exactly once when it finishes, gated behind
a human when the estimate is large, and never spent twice on work that may already have
completed.

```bash
git clone https://github.com/yuriiss/X-Forge-Factory.git
cd X-Forge-Factory
npm install
npm run setup     # writes .env.local, verifies your key against the live API
npm run build
npm start         # → http://127.0.0.1:7777
```

`npm start` serves the build. Use `npm run dev` only to work on X-Forge itself — it is the
development server, with hot reload and the slower first paint that comes with it.

To have the console come back after a reboot:

```bash
npm run service:install     # systemd user unit on Linux, launchd agent on macOS
```

It runs as you rather than as root, which is the point: the console spawns the coding CLIs
on this machine and reads the vault in your home directory, and a system service would find
neither. On Windows the same command prints the two ways to do it there — Task Scheduler or
the startup folder — rather than half-registering a service that needs elevation.

Then open **MCP Console → CONNECT** and sign in once. Without it the console still generates
images and video on the REST key, but you lose the balance, cost estimates, the full
catalogue, text-to-speech, 3D and most of Edit Suite.

> **New here?** [`GUIDEBOOK.md`](GUIDEBOOK.md) walks through every screen and every control,
> with screenshots — also built as a printable PDF at
> [`docs/X-Forge-Guidebook.pdf`](docs/X-Forge-Guidebook.pdf).
>
> **Українською:** [`GUIDEBOOK.uk.md`](GUIDEBOOK.uk.md) · [PDF](docs/X-Forge-Guidebook-UK.pdf).
> The console itself speaks both languages — the picker sits in the topbar.

---

## Requirements

| | |
|---|---|
| Node | 22.5 or newer — the database is `node:sqlite`, which arrives with Node itself |
| OS | Linux, macOS, Windows |
| Account | A Magnific API key, and a browser sign-in for MCP |

Windows works, with two things worth knowing. `.env.local` holds model and provider keys at
mode 600 on Linux and macOS; on Windows it inherits the folder's ACL instead, because
`chmod` has no equivalent there — so put the checkout somewhere only you can read. And the
service is not installed for you: `npm run service:install` prints the Task Scheduler entry
to create rather than half-registering something that needs elevation.

The Chat screen finds the coding CLIs by asking the system where they are — `which` on Linux
and macOS, `where.exe` on Windows — so a CLI installed while the console is open is noticed
within half a minute, on any of the three.

---

## What it does

Nothing in the console is mocked. Every panel is reading something.

| | Screen | What it actually does |
|---|---|---|
| ◈ | **Chat** | The coding CLIs installed on this machine — Claude, Grok, Kimi, Qwen, Codex — plus any OpenAI-shaped provider. Attach a picture, get a prompt, send it to a generator with one button. Skills pass a scanner first |
| ▦ | **Dashboard** | Live balance, the console's own rate meters, the job table, service health, vault thumbnails |
| ✦ | **Image Forge** | Mystic, FLUX and Seedream with their full parameter sets; the whole 48-model catalogue over MCP |
| ▶ | **Video Forge** | 52 models, text- and image-to-video, a free planning pass, per-model pricing before you commit |
| ♫ | **Audio Lab** | Music, sound effects, SAM isolation, TTS across ~600 voices, stock libraries |
| ◈ | **3D & Soul** | Image-to-GLB, Soul reference training, every trained character and style |
| ◉ | **Icon Foundry** | Text-to-SVG beside a search of finished vectors — check before you pay |
| ⇱ | **Upscale Studio** | Creative · Precision · Precision V2 · Skin Enhancer, 2× to 16×, priced first |
| ✂ | **Edit Suite** | Relight, expand, cutout, reimagine, camera, retouch, vectorise, crop |
| ⌘ | **Flows** | Published Spaces pipelines, with forms built from each flow's own declared inputs |
| ≣ | **Task Queue** | Every job in its real state, transition history, cancel and reconcile |
| ▤ | **Creations** | The local library and the account's history, never merged · full-size viewer with zoom, orbit for 3D |
| ❖ | **Stock** | Ten libraries — photos, vectors, illustrations, templates, PSDs, mockups, video, icons, music, sound effects — downloaded into the vault rather than linked |
| ⚗ | **Utilities** | Image → prompt, prompt improver, AI classifier |
| ⌁ | **MCP Console** | Live tool catalogue, schema-driven argument forms, priced calls |
| ∿ | **Analytics** | The engine's own ledger, outcome mix, audit trail |
| ⚙ | **Developers** | Credential, engine limits, webhook receiver, staging, reconciler |

<div align="center">
<img src="docs/images/image-forge.png" alt="Image Forge" width="49%">
<img src="docs/images/mcp.png" alt="MCP Console" width="49%">
</div>

---

## The engine

The rules it enforces, and where they live.

**Idempotency is per tenant.** `UNIQUE(tenant_id, idem_key)` — an identical request returns
the original job rather than a second charge, and two tenants writing the same prompt get
two different jobs. `src/lib/server/repo.ts`

**The tenant comes from the server.** Every repository call takes a context and throws
without one; a `tenant_id` in a request body, header or query string is stripped before it
reaches a handler. A foreign id answers `404`, never `403`.

**Credentials are envelope-encrypted.** Per-tenant DEK, master key from the environment,
decryption only inside the closure that makes the outbound call. Master-key rotation
re-wraps DEKs without touching ciphertext. `src/lib/server/secrets.ts`

**Redaction is a filter, not a habit.** Every log line passes through `redact()`, which
matches key formats, bearer tokens, JWTs and the live key by value. A test logs a key
deliberately and asserts the output is masked.

**The ledger is written once**, in `downloading → succeeded`, in the same transaction that
closes the reservation. An estimate is not a charge.

**Lost contact is not failure.** A timeout or 5xx after submission goes to `needs_recon`,
never back to the queue — the work may have happened and may already have cost money.
Reconciliation asks the provider and adopts the result.

**The gate cannot be lifted by software.** Anything over your threshold, or with a price the
provider will not quote, produces a one-time fifteen-minute link. There is no API endpoint
and no MCP tool that approves a job on a human's behalf.

**Nothing is downgraded to fit a budget.** A job that would breach the credit floor is
rejected with the reason. It does not quietly drop from 4k to 2k.

<div align="center">
<img src="docs/images/tasks.png" alt="Task Queue" width="100%">
<sub>Every job, in its real state, with the endpoint it used and what it cost.</sub>
</div>

---

## Pricing and rate shaping

Estimates come from Magnific's own `simulate_cost` — read-only, never charges — so the number
on the button is the provider's, not a price list in this repository. Where it cannot price a
call the capability table's figure is used and labelled as such; where the price is genuinely
unknown the job goes to the approval gate rather than being guessed at.

Two counters guard the provider's limits (50 requests per minute per key, plus IP burst and
average ceilings): a per-tenant RPM and a global outbound shaper, both consulted before a job
is admitted. Poll intervals back off with job age — six seconds for a fast image, thirty for a
video that will take minutes either way.

---

## Things the API does not document

Established by running it, and pinned by tests — a tidy-up toward the published reference
would break them silently.

- **Published names are not URLs.** The creative upscaler answers on `/v1/ai/image-upscaler`;
  text-to-image models need the `text-to-image` segment while Mystic alone sits on the flat
  path; background removal is still under `/v1/ai/beta/` and is form-encoded.
- **Video endpoints spell aspect ratios out** — `widescreen_16_9`, not `16:9` — and take
  `duration` as the string `'5'` or `'10'`, never the number.
- **`kling-v2-6-pro` accepts a POST and has no status route.** `GET …/kling-v2-6-pro/{id}` is
  a hard 404 while `kling-v2-5-pro/{id}` answers "task not found". Its result can only arrive
  by webhook, so the REST path runs 2.5 and 2.6 is reached over MCP.
- **Image → video refuses base64.** The still must be staged to a URL first.
- **`improve-prompt` requires an undocumented `type` field**; without it every call is a
  validation error.
- **MCP list tools answer in an indented outline, not JSON**, and send no `structuredContent` —
  the outline is the payload.
- **`simulate_cost` takes different arguments from the tool it prices.** Video is priced flat,
  not with the nested `clips[]` the generator needs. Calling it with `{}` makes it list its own
  required fields.
- **Background removal serves a PNG as `application/octet-stream`**, so the vault sniffs magic
  bytes rather than believing the header.

---

## Tests

```bash
npm run test:unit    # 34 — engine rules, tenant isolation, secrets, redaction, parsing
npm run test:api     # 24 — live, against your account, on the cheapest models
npm run test:e2e     #  4 — browser: every view, live data, no console errors
```

The API and browser suites need the console running. They spend about twenty credits per run —
a five-credit image, a two-credit voice line, a three-credit cutout — and never generate video.

And the acceptance run, which exercises every capability once for real:

```bash
node scripts/capability-sweep.mjs          # ~1 700 credits
node scripts/capability-sweep.mjs --all    # adds video and 3D
```

Last full run: **30 of 30 capabilities working**.

---

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · `node:sqlite` — no ORM, no external
database, no build step beyond Next. Engine state lives in `~/.x-forge`; generated assets go
wherever `FORGE_VAULT_DIR` points — sorted into `image/ video/ audio/ 3D/ vector/`, named by
date and label, each with a markdown note beside it, so an Obsidian vault is a first-class
destination rather than a dumping ground.

```
src/
  app/            routes and API handlers
  components/     the console — one file per screen
  lib/server/     engine, repository, adapters, MCP client, vault, secrets
scripts/          setup, capability sweep, screenshot capture, PDF build
tests/            unit · api · e2e
```

---

## Documentation

| | |
|---|---|
| [`GUIDEBOOK.md`](GUIDEBOOK.md) | Every screen and control, with screenshots — 22 sections |
| [`docs/X-Forge-Guidebook.pdf`](docs/X-Forge-Guidebook.pdf) | The same, typeset for print — 32 pages |
| [`GUIDEBOOK.uk.md`](GUIDEBOOK.uk.md) | Те саме українською — 22 розділи |
| [`docs/X-Forge-Guidebook-UK.pdf`](docs/X-Forge-Guidebook-UK.pdf) | Українською, для друку — 35 сторінок |
| [`CHANGELOG.md`](CHANGELOG.md) | What shipped, and when |
| [`.env.example`](.env.example) | Every setting, explained |

Rebuild the documentation with `npm run docs` — it recaptures the screenshots from a running
console, then rebuilds the PDF.

---

## Security

The API key never reaches the browser. It is sealed with envelope encryption at rest,
decrypted only in memory at the moment of an outbound request, redacted from every log line
by a filter rather than by convention, and returned by no endpoint. Revoking it erases the
ciphertext immediately and cancels everything queued.

`.env.local` is git-ignored and written with mode `600`. If you fork this repository, run
`npm run setup` rather than copying anyone else's environment.

---

## Credits

Built by **Yurii S.** — [@yuriiss](https://github.com/yuriiss).

Released under the [GNU Affero General Public License v3.0](LICENSE) — free software in
the full sense: run it, read it, modify it, share it, use it commercially. The one condition
that matters is copyleft: if you distribute a modified version, or **run one as a network
service that other people use**, those people must be able to get your source.

For the ordinary case — one operator running the console on `127.0.0.1` — the licence asks
nothing of you at all, whatever you generate and whoever you generate it for.

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md); for anything
touching credentials or the approval gate, read [`SECURITY.md`](SECURITY.md) first.

Magnific and Freepik are trademarks of their respective owners. This project is an
independent client built against their public API and MCP server, and is not affiliated
with, endorsed by, or supported by either.

---

<div align="center">
<sub>© 2026 Yurii S. · AGPL-3.0-or-later · built against the live Magnific API</sub>
</div>
