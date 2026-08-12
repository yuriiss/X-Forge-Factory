# Changelog

All notable changes to X-Forge. Format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] — 2026-08-12

A chat that talks to every model on the machine, skills behind a scanner, and a stock
library that hands over files instead of links.

### Added

- **Chat** — a seventeenth screen, second in the sidebar, that talks to the coding CLIs
  already installed on this machine rather than to Magnific: Claude Code, Grok, Kimi, Qwen
  Code, Codex and Antigravity, each spawned for one turn and streamed as it prints. No
  Magnific credits are involved, no job is created, and the CLI keeps its own transcript —
  the console resumes it by id instead of storing a worse copy.
- Which models exist is answered by looking at the machine, not by configuration: the rail
  lists every model X-Forge can drive and marks the ones that are not installed, because
  "Grok is missing" is more useful than a list that quietly omits it.
- **Providers** — OpenRouter, TokenRouter, FreeInference and any endpoint that answers the
  OpenAI chat shape, added by hand in Developers. Provider turns are billed by the provider
  on your own key.
- **Model and provider keys** in Developers, written to `.env.local` at mode 600 and applied
  to the running process immediately. Values come back masked; the file is the registry, so
  a custom provider survives a restart without a database.
- **Skills** — a picker beside the model that lists what is installed and searches
  skills.sh for what is not. Selected skills are named in the prompt for a CLI, and read
  from disk and sent as a system message for a provider, which discovers nothing.
- **A skill scanner.** Everything installed is downloaded into quarantine and read before
  anything reaches the skills directory: a pipe from curl into a shell, an instruction to
  send credentials somewhere, an instruction to conceal what it is doing — each is a hard
  block that no button can override. A shell script the scanner cannot inspect, or an
  explainable-but-odd pattern, needs a person and a written reason. Every decision, override
  included, is appended to `~/.x-forge/skill-audit.jsonl`.

- **One conversation, one model selector.** The choice lives on the server, so it is the
  same model in every tab and after a restart. Switching mid-conversation keeps the
  transcript: each CLI resumes its own session, and a model asked its first question in a
  conversation that started elsewhere is handed a short recap.
- **Attachments.** Attach a file or paste an image into the composer. A CLI is given the
  path and opens the file itself, at full resolution; a provider, which has no filesystem,
  is sent the image as data.
- **`→ USE AS PROMPT`** under every answer, sending the text to any of the five generators
  that take one and switching to that screen with the field filled. A fenced block wins over
  the prose around it, because a model asked for a prompt fences the prompt and explains
  outside it.
- **Skills you supply yourself** — a zip, a folder, or a pasted `SKILL.md` — through the same
  scanner as a registry install, with a hand-written zip reader rather than a new dependency.
- **`🔍 PREVIEW`** downloads a registry skill into quarantine and shows its text and its
  verdict without installing it.

- **Every model actually answers.** Five of the six CLIs failed on their first turn: Kimi
  rejects Claude's `--verbose`, Grok streams its deltas under `data`, Codex emits completed
  items, Qwen sends whole messages instead of deltas, and `antigravity` on PATH is the
  Electron IDE rather than a CLI — spawning it opened the editor and streamed its startup
  log into the chat. Each now has its own flags and its own reader, `agy` is used for
  Antigravity, and twenty tests pin the shapes to what the CLIs really print.
- **Conversations and CLI transcripts.** Three tabs: the chat, the conversations this
  browser holds, and the transcripts the model itself wrote on this machine — Claude, Kimi,
  Qwen, Codex, Grok and agy each in their own store. Opening one continues it.
- The chat fills the height it is given rather than floating above an empty page, and its
  type is a step larger: everywhere else the small text is a label read at a glance, here it
  is prose read a paragraph at a time.
- **Video Forge lists its catalogue** on the right, exactly as Image Forge does, instead of
  folding fifty-two models into a dropdown.
- **Stock downloads land in the vault.** The download button fetches the file through the
  provider's signed URL and files it in the library with a note, rather than opening the
  provider's website — photos, vectors, PSDs, templates, mockups, videos, icons, music and
  sound effects alike.
- **Ten stock libraries instead of five.** The resources endpoint takes a content-type
  filter, so photos, vectors, illustrations, templates, PSDs and mockups are each their own
  tab. 3D models and fonts are deliberately absent: no filter changes the answer for them,
  and a tab that lies is worse than one that is missing.
- Clicking a stock tile opens it full size, and a video plays there.

- **Music plays.** A sound effect carries its file in the search result; a music track only
  exists behind the download endpoint, so pressing play resolves it once and reuses it. The
  panel says plainly that this costs the same call a download does.
- Questions are asked in the console's own dress rather than the browser's: a confirm that
  says which skill, which transcript or which key, in the language the console is speaking,
  instead of a white box captioned with the origin.

### Fixed

- **The viewer lost the picture on zoom out.** Two faults: the offset was never bounded, so
  an anchor that made sense at 6× put the image off screen at 1×; and the offset was being
  set inside the scale updater, which React may run twice, applying the move twice. Zoom now
  bounds against how much of the picture actually overhangs the frame, and returns it to the
  centre once it fits.
- A tall image laid itself out past the stage, so "fit" was never a fit: `max-height: 100%`
  on a grid item resolves against the grid area, which was as tall as the picture.
- Stock thumbnails were blank because the URL extractor stopped at the first object, and a
  resource keeps its thumbnail at `image.source.url`. Music covers are gone rather than
  broken — that bucket answers 403 to everyone.

### Notes

The scan is static: it reads files and matches patterns, and never executes anything. It
catches the obvious attacks and will not catch a clever one, which is why the findings are
shown to the operator rather than reduced to a tick.

The zip reader refuses an entry that is absolute, holds `..`, holds a backslash, or resolves
outside the upload directory, and inflates with a hard output ceiling so a small archive
cannot claim a large one. Seven unit tests are written as those attacks.

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

[0.0.3]: https://github.com/yuriiss/X-Forge-Factory/releases/tag/v0.0.3
[0.0.2]: https://github.com/yuriiss/X-Forge-Factory/releases/tag/v0.0.2
[0.0.1]: https://github.com/yuriiss/X-Forge-Factory/releases/tag/v0.0.1
