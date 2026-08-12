# Magnific API field notes (formerly Freepik API)

Fifteen behaviours of the Magnific REST API and MCP server that the published reference does
not describe, or describes differently from how the service actually answers.

None of this is opinion. Each item was established by running the API against a live account
and is pinned by a test in this repository, so a later tidy-up toward the published reference
breaks a test rather than breaking silently.

**Why this page exists.** The full technical reference at `docs.magnific.com` is available
only on Business and Enterprise plans. Everyone else works from the marketing pages, the
error messages, and whatever the endpoint happens to return. If you arrived here from a
search for one of the error strings below, that is why.

**Rebrand note.** `api.freepik.com` and `api.magnific.com` are both live, the same key works
on both, and old endpoints carry deprecation headers. Everything below was verified against
`api.magnific.com`.

| | |
| --- | --- |
| Verified against | `api.magnific.com`, `mcp.magnific.com` |
| Date of last full verification | `<YYYY-MM-DD>` |
| How | `node scripts/capability-sweep.mjs --all` — 30 of 30 capabilities |
| Client | X-Forge `v0.0.4` |

If any of these has since been fixed, that is good news worth recording. Open an issue with
the date and what you saw.

---

## REST

### 1. Published model names are not URL segments

Take a model name from the catalogue, drop it into the path, get a 404 on an endpoint you are
certain exists. There is no single naming rule; at least four conventions coexist.

```
/v1/ai/mystic                          # Mystic, flat — no category segment
/v1/ai/text-to-image/flux-dev          # every other text-to-image model needs the segment
/v1/ai/text-to-image/seedream-v4-5     # and the version is punctuated, not dotted
/v1/ai/image-upscaler                  # creative upscaler: product name absent entirely
/v1/ai/image-upscaler-precision-v2     # its sibling, hyphenated version suffix
/v1/ai/skin-enhancer/creative          # category, then variant
/v1/ai/image-expand/flux-pro           # capability, then model
/v1/ai/beta/remove-background          # still under beta, and form-encoded, not JSON
/v1/ai/text-to-video/wan-2-5-t2v-1080p # resolution baked into the model id
/v1/ai/image-to-video/kling-v2-5-pro   # `v2-5` here, not `2-5`
```

Do not derive paths from names. Keep an explicit table from capability to endpoint, and treat
a new model as unmapped until it has answered once.

Pinned by `src/lib/server/magnific.ts` — `CAPABILITIES`.

### 2. Video aspect ratios are word forms, and REST disagrees with MCP

`"aspect_ratio": "16:9"` fails validation on the REST video models. The response says:

> Input should be 'widescreen_16_9', 'social_story_9_16' or 'square_1_1'

The accepted set is wider than that error suggests:

| Ratio | REST wire form |
| --- | --- |
| 16:9 | `widescreen_16_9` |
| 9:16 | `social_story_9_16` |
| 1:1 | `square_1_1` |
| 4:3 | `classic_4_3` |
| 3:4 | `traditional_3_4` |
| 3:2 | `standard_3_2` |
| 2:3 | `portrait_2_3` |
| 21:9 | `cinematic_21_9` |

The sharp part: **the MCP tools for the same models take `16:9`**. Two surfaces of one
vendor, same models, different vocabulary. If you talk to both, you need a translation layer
and you need to know which side you are on.

One practical detail: an unmapped ratio is better dropped than sent. Omitting the field uses
the model default, while a wrong value fails the whole request.

Pinned by `src/lib/server/engine.ts` — `NAMED_ASPECT`.

### 3. Video `duration` is a string, always

The enum is `'5' | '10'`. A numeric `5` is a validation error, not a coercion. Easy to break
by accident, because most serialisers will happily emit a number for a numeric-looking value
and the failure surfaces as generic validation rather than a type error.

```json
{ "duration": "5" }   // ok
{ "duration": 5 }     // validation error
```

Pinned by `src/lib/server/engine.ts` — `restBodyFor`, cases `video.t2v` and `video.i2v`.

### 4. `kling-v2-6-pro` accepts a POST and has no status route

Submit succeeds. Polling 404s forever.

`GET …/kling-v2-6-pro/{id}` is a hard 404 — the route does not exist. The neighbouring
version behaves differently: `GET …/kling-v2-5-pro/{id}` answers *task not found*, which is
the shape of a real status route that does not recognise the id.

That contrast is the whole diagnosis. A 404 from a missing route and a 404 from a missing
task are identical in a log line and mean opposite things: one says "you will never get an
answer here", the other says "wrong id, try again".

For 2.6 over REST the result can only arrive by webhook. Without a webhook receiver you will
pay for work you cannot collect, so this client runs 2.5 on the REST path and reaches 2.6
over MCP, where completion comes back through creations.

This is also the case that most justifies a `needs_recon` state rather than a retry. The job
may have run and may already have cost money.

Pinned by `src/lib/server/magnific.ts` — routing and comment on `video.i2v`.

### 5. Image-to-video refuses `data:` URLs

The source still must be reachable at a URL. Inline base64 is rejected regardless of size,
and the provider reports it as a validation error on a field the operator never typed — which
is why this client catches it locally instead:

> image → video needs a hosted image — re-drop the still so it is staged, then submit again

Consequence: an image-to-video pipeline is a two-step flow whether you wanted one or not, and
needs somewhere to put the intermediate file before it can start.

The same applies to `remove-background`, which needs a public `https` URL and refuses both
base64 and `data:`.

Pinned by `src/lib/server/engine.ts` (`video.i2v`) and `src/lib/server/magnific.ts`
(`removeBackground`).

### 6. `improve-prompt` requires an undocumented `type` field

Every call fails validation without it, including calls that match the published example.
Sending `type` fixes it; `"image"` is a working value.

```json
{ "prompt": "…", "type": "image" }
```

Because the field is undocumented, treat its accepted values as discovered rather than
specified.

Pinned by `src/app/api/utilities/[tool]/route.ts`.

### 7. Duration is named differently on every endpoint that has one

There is no shared convention:

| Endpoint | Field |
| --- | --- |
| `/v1/ai/music-generation` | `music_length_seconds` |
| `/v1/ai/sound-effects` | `duration_seconds` |
| `text-to-video`, `image-to-video` | `duration`, as a string |

Pinned by `src/lib/server/engine.ts` — `restBodyFor`.

### 8. Completed tasks answer with plain URL strings, except audio

`data.generated[]` is usually an array of strings. Audio returns objects, with the URL under
one of several names: `url`, `audio_url`, `image_url`, `video_url`. A client that assumes
strings will try to download `[object Object]`.

Pinned by `src/lib/server/magnific.ts` — `pollTask`.

### 9. The useful part of an error is in `invalid_params`, not `message`

`message` is often just *Validation error*, which tells an operator nothing. The specific
complaint arrives in `invalid_params[]` as `{ field, reason }` pairs. Surfacing those is the
difference between "try again" and "duration must be '5' or '10'".

Pinned by `src/lib/server/magnific.ts` — `rest()`.

---

## MCP

### 10. Framing must be decided by `Content-Type`, never by sniffing the body

The MCP server may answer either JSON or an SSE frame **for the same request**. The obvious
shortcut is to look at the body and decide. Do not.

`tools/list` descriptions themselves mention `data:` URLs. A body-sniffing client sees what
looks like an SSE payload, takes the wrong branch, and parses the entire 88-tool catalogue as
`{}` — an empty result, with no error anywhere.

Pinned by `src/lib/server/mcp.ts` — transport branch.

### 11. Several list tools answer in an indented outline, with no `structuredContent`

The outline is not a human-readable summary sitting alongside machine-readable data. It *is*
the payload. There is no `structuredContent` field to fall back to.

```
items[3]:
  - slug: kling-26
    name: Kling 2.6
    family: Kling
    expectedGenerationTime: 600
    aspectRatios[3]: "1:1","16:9","9:16"
    durations[2]: 5,10
    keyframes:
      start:
        assetType: image
  - slug: wan-2-5
    name: Wan 2.5
    beta: true
```

Note the counted list syntax (`items[3]:`, `aspectRatios[3]:`) and that nested sub-objects
appear at deeper indentation. Both matter to the parser.

Pinned by `src/lib/server/mcp.ts` — `parseOutline`; `tests/unit/protocol.test.ts`.

### 12. `folders_list` nests the parent project inside each folder

A parser that tolerates one level of nesting too many lets `parent.name` overwrite the
folder's own `name`. The symptom looks like a data problem rather than a parsing one: a
folder called *Personal* is displayed under the name of the project it happens to live in.

```
items[1]:
  - reference: c46bb63f-…
    name: Personal
    parent:
      id: aa351c8a-…
      name: workspace          ← must not win
    backgroundUrl: "https://…"
```

Pinned by `tests/unit/protocol.test.ts` — "does not let a nested field overwrite the record's
own".

### 13. `simulate_cost` takes different arguments from the tool it prices

Copying the generation call's arguments into the pricing call does not work. Video is the
clearest case: the generator takes a nested `clips[]` structure, while the pricer wants a
flat `{ slug, duration, resolution }`. Calling it with the tool's own shape answers *the api
field is required*, which reads like a broken integration and is really two contracts wearing
one name.

**The trick that makes this tractable:** call `simulate_cost` with `{}`. It replies by listing
its own required fields. That is how these mappings were found, and it is faster and more
reliable than reading anything.

Two more things worth knowing:

- It is read-only and never charges, which makes it safe to call before committing.
- It prices a **model**, not a capability. Without an explicit model slug, a REST job on a
  named model is priced as `mode: auto` — the server's answer for "I will decide later",
  which is honest for auto and wrong for everything else.

Where it cannot price a call at all, the honest move is to route the job to a human approval
gate rather than guess at a number.

Pinned by `src/lib/server/engine.ts` — `costArgsFor`.

### 14. Generation results are inconsistent about where the asset lives

Some tools return `structuredContent.items[]`, some return identifiers embedded in prose,
some return both. And `webUrl` is a gallery page for a human, not an asset — following it
downloads HTML.

Pinned by `src/lib/server/mcp.ts` — `extractUrls`, `extractIdentifiers`;
`tests/unit/protocol.test.ts`.

---

## Assets

### 15. Background removal serves a PNG as `application/octet-stream`

The body is a PNG. The header does not say so. A client that branches on `Content-Type` files
a perfectly good image under "binary" and renders it as a download link.

Sniff the magic bytes instead. PNG is `89 50 4E 47 0D 0A 1A 0A` in the first eight.

Generalise it: for any endpoint returning binary, the content type is a hint, not a fact.
This client sniffs PNG, JPEG, WebP, WAV, MP4, glTF, MP3 and SVG on the way into the vault,
and logs whenever the sniffed type disagrees with the declared one.

Pinned by `src/lib/server/vault.ts` — `sniff()`, `downloadToVault`.

---

## How these were found

By running every capability once, for real, against a live account, and writing down what came
back rather than what should have.

```bash
node scripts/capability-sweep.mjs --all
```

Last full run: 30 of 30 capabilities working.

---

*Part of [X-Forge](https://github.com/yuriiss/X-Forge-Factory), an operator console for
Magnific. Magnific and Freepik are trademarks of their respective owners. This project is an
independent client built against their public API and MCP server, and is not affiliated with,
endorsed by, or supported by either.*
