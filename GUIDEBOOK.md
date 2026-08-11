# X-FORGE · Operator Guidebook

<sub>X-Forge v0.0.1 · by Yurii S. ([@yuriiss](https://github.com/yuriiss)) · AGPL-3.0-or-later</sub>

Everything in this console spends real credits from a real Magnific account. This guide
covers every screen and every control: what it does, what it costs, what it needs from you
first, and what to do when it refuses.

**Contents**

1. [Before you start](#1-before-you-start)
2. [The shell — sidebar, topbar, and what the numbers mean](#2-the-shell)
3. [How a job works](#3-how-a-job-works)
4. [Dashboard](#4-dashboard)
5. [Image Forge](#5-image-forge)
6. [Video Forge](#6-video-forge)
7. [Audio Lab](#7-audio-lab)
8. [3D & Soul](#8-3d--soul)
9. [Icon Foundry](#9-icon-foundry)
10. [Upscale Studio](#10-upscale-studio)
11. [Edit Suite](#11-edit-suite)
12. [Flows](#12-flows)
13. [Task Queue](#13-task-queue)
14. [Creations](#14-creations)
15. [Stock](#15-stock)
16. [Utilities](#16-utilities)
17. [MCP Console](#17-mcp-console)
18. [Analytics](#18-analytics)
19. [Developers](#19-developers)
20. [The approval page](#20-the-approval-page)
21. [Costs at a glance](#21-costs-at-a-glance)
22. [When something goes wrong](#22-when-something-goes-wrong)

---

## 1. Before you start

```
npm install
npm run dev          # http://127.0.0.1:7777
```

The console needs two things, and the topbar tells you whether it has them.

**A Magnific API key**, in `.env.local` as `MAGNIFIC_API_KEY`. It is sealed into the
database on first boot and never leaves the server — no endpoint returns it, and nothing in
the browser ever sees it. You can replace or revoke it in **Developers**.

**An MCP session**, which is a browser sign-in rather than a key. Without it the console
still generates images and video on the REST paths, but you lose: the credit balance, cost
estimates, the full model catalogue, text-to-speech, 3D, and most of Edit Suite. Connect it
in **MCP Console → CONNECT**.

Two panels tell you what state you are in at any moment: the topbar's `API` / `MCP` lights,
and **Dashboard → Services**.

---

## 2. The shell

![Dashboard](docs/images/dashboard.png)

### Topbar

| Element | Meaning |
|---|---|
| `API connected` | The REST key answered an authenticated call in the last minute |
| `MCP OAuth` | The MCP session handshook successfully |
| `◆ N CREDITS` | **Spendable** credits: the account balance minus what open jobs have reserved |
| `KEY · …9f79` | Last four characters of the stored key. Click to open Developers |
| `x-magnific-api-key` | A reminder of the auth header. Click to open Developers |
| Clock | Local time, for correlating with job ages |

The credit chip is the number that matters. If the balance says 40 000 and two video jobs
are in flight, the chip shows what is actually left to spend.

### Sidebar

Sixteen views in six groups. Every view is mounted only while shown, so opening one starts
its own polling and leaving it stops. The dot beside **MCP Console** is green when the
session is live, red when it is not.

### Toasts

Bottom-right. Amber for information, green for success, red for failure. Errors stay for
nine seconds; everything else for four and a half.

---

## 3. How a job works

Every generation in this console — regardless of which screen you started it from — becomes
a *job* and walks the same path. Understanding it takes two minutes and explains every
message you will see.

```
created → validating → budget_check → queued → reserved
       → submitted → running → downloading → succeeded
                            ↘ failed_retryable → queued  (once, at most)
                            ↘ failed
                            ↘ needs_recon
validating → blocked_approval → budget_check
budget_check → rejected_budget
* → cancelled  (only before submitted)
```

**validating** — the price is fetched from Magnific's own cost simulator before anything
runs.

**blocked_approval** — the estimate is over your threshold, or the provider refused to
quote a price. The console gives you a one-time link; nothing runs until a human opens it.
See [§20](#20-the-approval-page).

**budget_check** — seven checks, in this order: the tenant is active; a credential exists;
you are under your concurrent-job limit; the balance minus the estimate stays above your
credit floor; video is enabled if this is video; you are under your own RPM limit; the
global outbound shaper has room.

**reserved** — the estimate is held against your balance so two jobs cannot each spend the
last of it.

**submitted → running → downloading** — the work is with Magnific. Results are downloaded
into the local vault immediately, because provider URLs expire in about a day.

**succeeded** — the ledger is written **once**, in the same transaction that closes the
reservation.

**needs_recon** — the console lost contact after submitting. The work may have happened and
may already have cost money, so it is never re-run automatically. Resolve it in
[Task Queue](#13-task-queue).

Two rules worth internalising:

- **Nothing is ever downgraded to fit your budget.** A job that would breach the floor is
  rejected with the reason. It does not quietly drop from 4k to 2k.
- **An identical request returns the original job.** Same capability, same parameters, same
  prompt → the same job, not a second charge.

---

## 4. Dashboard

![Dashboard](docs/images/dashboard.png)

**Credits** — the ring is how much of the monthly plan has been consumed. `BALANCE` is what
the account holds, `PLAN` is the monthly allowance, `SPENT TODAY` and `JOBS TODAY` come from
the console's own ledger. The line underneath tells you how much is reserved by jobs that
have not finished.

**Rate Limits** — three live meters, all measured by this console, not guessed:

| Meter | What it counts |
|---|---|
| `THIS TENANT · N RPM` | Your own outbound requests in the last minute |
| `OUTBOUND SHAPER` | All tenants' requests through this process |
| `BURST · 5s WINDOW` | Requests in the last five seconds |

Magnific allows 50 requests per minute per key. When the tenant meter hits its ceiling, new
jobs are **rejected** with `rpm_exceeded` — that is the shaper protecting the key, not a
bug. Wait a minute, or raise the limit in Developers.

**Task Queue** — the six most recent jobs. `OPEN ›` goes to the full queue.

**Services** — six lights: REST, MCP, credential, engine status, whether video is enabled,
and the vault's retention setting.

**Recent Creations** — thumbnails from the local vault. These are files on your disk, not
provider URLs, so they do not expire.

**Activity** — the job event log, which is every state transition with its reason.

**Quick Launch** — four shortcuts to the screens people use most.

---

## 5. Image Forge

![Image Forge](docs/images/image-forge.png)

The main generator. Four tools along the top pick which path you run on.

| Tool | Runs on | Reaches |
|---|---|---|
| `MYSTIC` | REST | Mystic, with its full parameter set — references, LoRAs, engines |
| `FLUX` | REST | FLUX.1 dev |
| `SEEDRM` | REST | Seedream 4.5 |
| `CATLG` | MCP | The **whole** catalogue — 48 models, chosen from a dropdown |

The REST tools give you every Magnific-specific control. The catalogue gives you every
model Magnific offers, with a simpler parameter set. Neither is better; they are different
surfaces, and the panel header always says which one you are on.

### Using it

1. **PROMPT** — plain language. If you have trained a character in [3D & Soul](#8-3d--soul),
   reference it as `@name`, or `@name::200` to push its strength.
2. **MODEL** — for Mystic, six looks (`realism` is the least "AI-looking"). For the
   catalogue tool, a dropdown of all 48 models with their typical generation time.
3. **ASPECT RATIO** and **RESOLUTION** — `2k` is the sensible default; `4k` costs more.
4. **CREATIVE DETAILING** — how much detail Mystic invents per pixel. High values look
   striking and produce stray artifacts. 30–40 is a good working range.
5. **REFERENCES & STYLE** — drop an image into `structure_reference` to control composition,
   or `style_reference` to transfer a look. The sliders under each control how strongly.
   **References silently disable LoRAs** — that is Magnific's behaviour, and no error is
   returned, so pick one approach or the other.
6. **STYLING · LORA** — the characters and styles trained on this account. Click to include.
7. **WEBHOOK_URL** — optional; the console polls anyway.
8. Press **GENERATE**. The button always shows the current estimate.

### The workspace

`OUTPUT` shows the result and its badges: status, path used, credits, file count.
`HISTORY` is your previous successful jobs — click one to bring it back.
`REQUEST` shows exactly what the console will send, with base64 payloads collapsed to their
size. Use it when something is rejected and you want to see the actual body.

### The catalogue panel

All 48 models, live from the server. **Amber dot** = also reachable on REST (more controls);
**green dot** = MCP only. Clicking a model switches to the catalogue tool with it selected.

---

## 6. Video Forge

![Video Forge](docs/images/video-forge.png)

Video is the expensive family — a five-second clip is typically 225–1 500 credits — so this
screen is built around knowing the price first.

### Using it

1. **MODE** — `T2V` (text only) or `I2V` (from a still).
2. **MODEL** — 52 models, or `auto`. When you pick one, the panel shows the durations it
   accepts. Models with a REST path run on your key; the rest run over MCP.
3. **PROMPT** — describe the motion, not just the scene. "Slow dolly-in, product rotates on
   velvet plinth" beats "a product".
4. **PLAN · FREE** — runs Magnific's own planner. It costs nothing and returns a brief, a
   recommended model and a prompt draft. Worth doing before spending 300 credits.
5. For `I2V`, drop a **first frame**. The console stages it to a hosted URL automatically —
   the video models refuse inline images. Optionally add a **last frame** for a transition.
6. **RESOLUTION / DURATION / ASPECT RATIO** — the console translates these into whatever
   wire format the endpoint wants.
7. Toggles: native audio, locked framing, a seed for repeatability.
8. **GENERATE**. Anything over your threshold produces an approval link instead of running.

The **TASK** panel underneath shows the endpoint, the provider task id, the live status and
what was reserved. The **Request** block at the bottom of the page is the exact payload.

> **If video is disabled** the button refuses and tells you. Enable it in
> **Developers → Engine Limits → VIDEO GENERATION**. It is off by default deliberately: it
> is the fastest way to spend a lot of credits by accident.

---

## 7. Audio Lab

![Audio Lab](docs/images/audio-lab.png)

Four independent tools. Each has its own runner, so you can have a music render and a sound
effect in flight simultaneously without them overwriting each other's results.

**Music Generation** (REST, ~80 credits for 15 s) — prompt, optional negative prompt,
length, optional seed. Describe instrumentation and tempo; "warm synthwave bed, analog pads,
84 BPM" works better than "nice music".

**Sound Effects** (REST, ~20 credits) — one short description, one duration. Good for
foley and interface sounds.

**Audio Isolation · SAM** (REST) — drop an audio or video file, name the sound you want
pulled out ("lead vocal", "engine", "rain"). The description is what steers it, not the
file.

**Text to Speech** (MCP) — needs the MCP session. The voice dropdown carries the account's
full catalogue (about 600 voices); the filter box searches by name and language. Cost scales
with text length and is shown before you press the button.

**Audio Libraries** at the bottom search Magnific's stock music and sound-effect catalogues.
These are downloads against your plan's daily allowance, not credit purchases.

---

## 8. 3D & Soul

![3D and Soul](docs/images/soul-forge.png)

### Image → 3D

`models3d_generate` is **image**-to-3D, not text-to-3D. Drop a picture of a single clean
subject; the console imports it as a creation for you.

- `tripo-p1` — fast, the default
- `tripo-v31` — higher quality
- `trellis-2` — a different reconstruction approach

Output is a GLB (~580 credits), downloaded to the vault. A browser cannot preview a GLB
without a viewer, so it is stored intact for you to open in a 3D tool.

### Train Soul Reference

Teaches Magnific a character or a style you can then use by name in any prompt.

1. **TYPE** — `character` (a person) or `style` (an aesthetic).
2. **NAME** — this is literally what you will type in prompts afterwards, as `@name`.
3. **GENDER** (characters only) and **QUALITY**.
4. **TRAINING IMAGES** — drop **at least four**, ideally 4–12, all consistent: the same face,
   the same outfit, or the same art style. Each drop is staged and added to the list; click a
   chip to remove it.
5. **START TRAINING**. Training runs on Magnific's side and takes a while — the reference
   appears in the list on the right marked `READY` when it finishes.

### Trained References

Everything this account can already use, from both places references live: LoRAs on the REST
key and the Library on the MCP session. The list is cached for five minutes because the
provider's endpoint takes about twelve seconds to answer.

---

## 9. Icon Foundry

![Icon Foundry](docs/images/icon-foundry.png)

Two halves that answer the same question — "I need an icon" — in opposite ways.

**Generate Icon** (~375 credits) makes an icon that does not exist yet, as a real SVG.
Describe it, pick a style (`line`, `flat`, `glyph`, `3d`, `pixel`), generate. Vector output
scales without loss, unlike an upscaled raster icon.

**Icon Library** searches Magnific's catalogue of finished vectors. Free against your plan's
download allowance.

**Search the library before generating.** If the icon already exists, generating it again
costs 375 credits for no benefit.

---

## 10. Upscale Studio

![Upscale Studio](docs/images/upscale.png)

The Magnific flagship, in four modes.

| Mode | What it does | Use when |
|---|---|---|
| **Creative** | Invents plausible detail, guided by a prompt | The source is small or soft and you want it to look striking |
| **Precision** | Faithful enlargement, engine-driven | The content must not change |
| **Precision V2** | Faithful, with sharpen / grain / ultra-detail controls | Photographic work needing fine control |
| **Skin Enhancer** | Portrait retouch | Faces |

### Using it

1. Drop an image, **or** click one from **FROM THE VAULT** — anything you have generated is
   one click away.
2. **SCALE FACTOR** — 2× to 16×. This is the single biggest cost driver: cost scales with
   *output* area, so 16× on a large source is an order of magnitude more than 2× on a small
   one. The **Estimated Cost** panel on the right shows the provider's own number and its
   range across size tiers.
3. **OPTIMIZED FOR** — tell it what the picture is (portraits, landscapes, game assets, 3D
   renders…). This matters more than people expect.
4. **ENGINE** — `automatic` unless you know you want `illusio`, `sharpy` or `sparkle`.
5. **PROMPT** — for Creative mode. *Reuse the original generation prompt* if you have it;
   it noticeably improves the result.
6. **CREATIVITY / HDR / RESEMBLANCE / FRACTALITY** — all −10…+10. Start at 0 and move one at
   a time. High creativity plus high HDR is where the "over-processed" look comes from.

The workspace has three views: `BEFORE / AFTER` (side-by-side), `SIDE BY SIDE`, and
`OUTPUT ONLY`.

---

## 11. Edit Suite

![Edit Suite](docs/images/edit-suite.png)

Eight tools that take one image and return one image. Pick a tool from the grid, drop a
picture, fill in what that tool needs. The form changes with the tool.

| Tool | Path | Needs | Notes |
|---|---|---|---|
| **Relight** | REST | inline image | Changes lighting without changing content. Optional reference image to copy lighting from |
| **Image Expand** | REST | inline image | Outpaints beyond the frame into a new aspect ratio |
| **Remove Background** | REST | **hosted URL** | Refuses inline images — the console stages the file for you |
| **Reimagine** | MCP | creation | Variations on an existing image |
| **Change Camera** | MCP | creation | A new angle on the same scene |
| **Retouch** | MCP | creation | Change one region, leave the rest |
| **Raster → SVG** | MCP | creation | Vectorise a bitmap |
| **Smart Crop** | MCP | creation | Re-frame to a ratio, keeping the subject |

You do not have to care which form the input needs: one drop produces all three (a local
copy, a hosted URL, and an MCP creation) and each tool takes what it wants. If the MCP
session is down, the MCP tools will say so rather than failing obscurely.

**Relight** has the deepest controls: light transfer strength, whether to interpolate from
the original, whether the background may change, and separate whites/blacks levels.

---

## 12. Flows

![Flows](docs/images/flows.png)

A flow is a pipeline someone built on Magnific's Spaces canvas and published. This screen
runs them.

1. Pick `PUBLISHED` (the whole catalogue — 57 at the time of writing) or `MINE`.
2. Select one. The canvas draws its shape and the header shows its cost per run.
3. The **Run Flow** panel builds itself from that flow's declared inputs — every flow has a
   different set, so nothing here is hardcoded. Fill them in.
4. Optionally add a webhook.
5. **RUN**.

Runs appear in the **Runs** panel with a `POLL` button. Statuses are the provider's:
`pending`, `running`, `completed`, `completed_with_errors`, `failed`, `cancelled`.

Flow results are valid for about twelve hours, shorter than everything else.

---

## 13. Task Queue

![Task Queue](docs/images/tasks.png)

Every job the engine has, filterable by state. The columns tell you the job, the exact
endpoint it used, whether it went over `rest` or `mcp`, its state, its age, its credits, and
what you can do about it.

**Click any row** to open its detail: the parameters, the provider task id, estimate versus
actual, and the complete transition history with timestamps and reasons. This is the fastest
way to understand what a job actually did.

### What the actions mean

| Button | When it appears | What it does |
|---|---|---|
| `OPEN` | The job produced files | Opens the asset |
| `CANCEL` | Before submission | Cancels the job. Nothing was spent |
| `RECONCILE` | `needs_recon` only | Asks Magnific what happened to the task |

**`RECONCILE` is the important one.** A job in `needs_recon` means the console lost contact
after submitting — the generation may have completed and charged you. Reconciling asks the
provider directly: if the work exists it is downloaded and the ledger is written once; if it
failed, the job is marked failed. The console will never silently re-run it, because that
would be paying twice for the same picture.

The three panels underneath document the polling strategy, the webhook signature scheme, and
what the console does with each provider error code.

---

## 14. Creations

![Creations](docs/images/creations.png)

Two libraries, deliberately not merged.

**VAULT** — everything this console has generated, downloaded to your disk. Permanent,
playable, searchable by label or model.

**ACCOUNT** — the Magnific account's own recent creations, made anywhere. URLs here expire.

Filter by type on the left; folders and spaces come from the MCP session. Click any
thumbnail to load the **Inspector**, which shows the file, its metadata, and gives you
download and copy-URL buttons.

**Import Asset** is the three-way importer: one drop stores the file locally, stages it for
the REST endpoints, and imports it as an MCP creation — the same thing every dropzone in the
console does.

---

## 15. Stock

![Stock](docs/images/stock.png)

Five libraries behind one search box: images, videos, music, sound effects, icons. Type,
press Enter or `SEARCH`.

Stock is **not** priced in credits. Below a Business plan you get 100 downloads a day; on
Business and above it is unlimited. The panels at the bottom document the rules, which
endpoint each tab reads, and the fact that stock searches share the same outbound rate
budget as your renders.

Usage terms worth remembering: no data mining, no scraping, no resale without modification.

---

## 16. Utilities

![Utilities](docs/images/utilities.png)

Four small tools that answer in words instead of files. They cost no credits — they are
limited to 1 000 requests a day instead — and they run immediately rather than going through
the job engine.

**Image → Prompt** — drop a picture, get a reusable prompt describing it. `SEND TO IMPROVER`
chains it into the next tool.

**Improve Prompt** — turns a thin prompt into a detailed one. `IMPROVE AGAIN` iterates.

**AI Classifier** — checks whether an image was AI-generated. This capability is plan-gated;
if your plan does not include it the panel reports the provider's own answer rather than
showing an empty result.

**Video Plan** lives in [Video Forge](#6-video-forge) rather than here, because that is where
you need it.

---

## 17. MCP Console

![MCP Console](docs/images/mcp.png)

The Model Context Protocol side of Magnific: 88 tools reached over an OAuth session, no API
key involved.

### Connecting

Press **CONNECT**. A popup opens Magnific's sign-in; approve once. The console registers
itself dynamically, uses PKCE, and asks for `offline_access` so the session survives longer
than an hour. Everything on the page refreshes when you come back.

**DISCONNECT** forgets the tokens. The REST paths keep working.

### The server panel

Transport, server identity, issuer, scopes, token expiry and session id. If the session is
broken this panel says why in plain terms.

### Call a tool

This is a real console, not a demo.

1. Pick a tool from the dropdown — all 88, with their descriptions.
2. The argument form **builds itself from that tool's JSON schema**: enums become dropdowns,
   numbers are sent as numbers, required fields are marked. Switch to `RAW JSON` if you would
   rather type the object yourself.
3. **CALL TOOL**.

Tools that spend credits are priced first: the console runs the cost simulator, shows you the
number, and waits for **CONFIRM AND SPEND**. Free tools run immediately. Results are shown as
data, with any returned images rendered inline.

### Tool Catalog

All 88 tools, grouped, each labelled `FREE` or `CREDITS`. Filter by name; click any tool to
load it into the caller. This list is `tools/list` read live from the server, so a tool
Magnific ships next week appears here without a code change.

### Connect another client

Copy-paste setup for Claude Code, Cursor, ChatGPT and Claude web. Any streamable-HTTP MCP
client works.

---

## 18. Analytics

![Analytics](docs/images/analytics.png)

**Credit Usage** is the console's own ledger — one row per job, written once, in the same
transaction that closed its reservation. Pick 7, 14 or 30 days. The bars are daily spend;
hover for exact figures.

**By Model** breaks the same spend down by model and capability, which is how you find out
that upscales are quietly your biggest line item.

**Outcomes** counts every terminal state, including the unflattering ones — failures,
budget rejections and cancellations are all shown.

**Team analytics** is Magnific's own `/v1/analytics/*`, available on Business and Enterprise
plans. On other plans the panel says exactly that, with the provider's own message, rather
than rendering an empty chart.

**Audit trail** is the job event log: every state transition with its reason.

---

## 19. Developers

![Developers](docs/images/developers.png)

The control panel for the engine itself.

### Magnific Credential

Shows the last four characters, a truncated fingerprint and when the key was last verified.
The key itself is never displayed, returned or logged.

- **VERIFY & SAVE** — paste a new key. It is checked with a live call *before* being stored;
  an invalid key is never saved and the previous one is restored.
- **REVOKE** — erases the stored key immediately and cancels everything queued.

### Engine Limits

These are yours to set. Change a value and press `SAVE`.

| Limit | What it does | Sensible default |
|---|---|---|
| **APPROVAL THRESHOLD** | Any job estimated above this waits for a human | 400 credits |
| **CREDIT FLOOR** | Jobs that would drop the balance below this are rejected | 0, or a reserve you never want touched |
| **MAX CONCURRENT JOBS** | How many jobs may be in flight | 3 |
| **RPM LIMIT** | Your own ceiling, under Magnific's 50/min per key | 45 |
| **RETENTION · DAYS** | How long vault files are kept | 30 |
| **VIDEO GENERATION** | Master switch for the whole video family | Off until you need it |

If the reconciler ever parks the engine in `safe_mode` — it does that when the balance drifts
from what the ledger expects — this panel is where you read why and press `RESUME`.
**RECONCILE NOW** runs that check on demand.

### Webhook Receiver

The URL to pass as `webhook_url` on any job, the verification scheme, and a live record of
recent deliveries marked `VERIFIED` or `REJECTED`. An unverified delivery is answered `401`
and never acted on; a replayed one outside the freshness window is refused even with a valid
signature.

### Uploads · Staging Area

How many files are currently staged provider-side, and the three-step protocol behind every
dropzone in the console. Staged files expire in about a week — the vault is what keeps
things.

---

## 20. The approval page

![Approval page](docs/images/approval.png)

When a job's estimate is over your threshold — or the provider will not quote a price at all
— the console does not run it. It gives you a link like:

```
http://127.0.0.1:7777/a/job_0MSOQ53FKBC0DEZI0LW/6fa58580e9476168d43a9458a315c43e
```

The page opens with no session, so you can send it to whoever holds the budget. It shows the
model, the parameters, the estimate, your spendable balance and the time remaining.

- **APPROVE & RUN** queues the job.
- **CANCEL JOB** ends it, having spent nothing.

The link is **single-use** and expires after fifteen minutes. There is deliberately no API
endpoint and no MCP tool that approves a job — an agent must not be able to imitate a human
saying yes.

---

## 21. Costs at a glance

Measured on a Premium account. Treat as orders of magnitude, not a price list — the console
always shows the provider's own estimate before you commit.

| Operation | Typical | Notes |
|---|---|---|
| Remove background | 3 | Cheapest thing here |
| Image · HyperFlux | 5 | Cheapest generator; ideal for tests |
| Text to speech | 2–10 | Scales with text length |
| Sound effect | 20 | |
| Image · Mystic / FLUX.2 / Seedream | 50 | |
| Image expand | 50 | |
| Upscale 2× | 72 | Scales with **output** area |
| Relight | 75 | |
| Music, 15 s | 80 | |
| Variations | 150 | |
| Upscale 4× on a 1k source | ~216 | |
| Video, 5 s | 225–1 500 | Varies enormously by model |
| Icon → SVG | 375 | Search the library first |
| Image → 3D GLB | 580 | |
| Stock downloads | 0 | Daily allowance, not credits |
| Utilities | 0 | 1 000 requests/day |

A full sweep of every capability in the console, once each, on the cheapest settings, is
about 2 300 credits.

---

## 22. When something goes wrong

### "rejected_budget · rpm_exceeded"

You are at your requests-per-minute ceiling. The shaper is protecting the key. Wait a minute
or raise **RPM LIMIT** in Developers — but not above 50, which is Magnific's own limit.

### "rejected_budget · insufficient_credits"

The estimate would push the balance below your credit floor. Lower the floor, top up the
account, or choose a cheaper model. The console will not silently reduce quality to fit.

### "rejected_budget · video_disabled"

Enable video in **Developers → Engine Limits**.

### "rejected_budget · max_concurrent"

Too many jobs in flight. Wait, or raise the limit.

### A job sits in `needs_recon`

The console lost contact after submitting. Open **Task Queue**, click `RECONCILE`. If the
work completed, it is downloaded and charged once; if it failed, the job is closed. Never
just re-submit — that pays twice.

### "Validation error" with a field name

The provider rejected a specific parameter, and the console passes its exact complaint
through — `duration: Input should be '5' or '10'` means precisely that. The `REQUEST` tab in
Image Forge and the request block in Video Forge show what was sent.

### An MCP tool says "not connected"

The OAuth session expired or was disconnected. **MCP Console → CONNECT**. The REST paths keep
working meanwhile; the affected features are TTS, 3D, cost estimates, the full catalogue and
most of Edit Suite.

### "image → video needs a hosted image"

The still was not staged. Re-drop it and submit again — the console stages uploads
automatically, but a file added before the MCP session came up may lack the hosted copy.

### A generation just fails once

Providers have bad minutes. The console retries a retryable failure once, then stops and
tells you. Submitting again with a slightly different prompt is the fastest test — an
identical prompt returns the original failed job by design.

### The balance looks wrong

Press **RECONCILE NOW** in Developers. It compares the account against the ledger; drift past
the threshold parks the engine in `safe_mode` so nothing new spends until you have looked.
