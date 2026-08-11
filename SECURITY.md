# Security

X-Forge holds an API key that spends money. That shapes what counts as a security issue here
and how to report one.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/yuriiss/X-Forge-Factory/security/advisories/new).

Please include what you did, what happened, and what you expected. A job id and its state
transitions (Task Queue → click the row) are usually more useful than a description.

Never paste an API key, a bearer token, a webhook secret or an unredacted log into a report.
If you believe you have found a leak, describe where it appears rather than pasting the value.

Expect an acknowledgement within a few days. This is a single-maintainer project, so please
allow reasonable time before disclosing publicly.

## What counts

Anything that could spend an operator's credits without their intent, or expose the
credential that spends them:

- A path by which the approval gate can be lifted without a human — the gate is deliberately
  unreachable from the API and from MCP.
- A way to make a job charge twice, or to have work re-run after a lost connection instead of
  going to `needs_recon`.
- The API key, a master key, or a bearer token appearing in a response, a log line, an export,
  an error message, or the browser.
- Cross-tenant access: reading another tenant's job, asset or balance. Foreign identifiers
  must answer `404`, never `403`.
- Webhook forgery: a delivery accepted without a valid signature, or a replay outside the
  freshness window.
- Reading an asset by guessing an identifier — an identifier is not an access right.

## What does not

- **Provider-side behaviour.** A Magnific endpoint changing shape, rate-limiting you, or
  failing a generation is not a vulnerability in this project. Open a normal issue.
- **Spending your own credits.** The console will run what you approve. The approval
  threshold, credit floor and video switch exist so you decide where that line sits.
- **Running the console on a public interface.** It binds to `127.0.0.1` and assumes a single
  trusted operator; there is no authentication layer in front of the UI. Exposing it to a
  network is out of scope by design.

## How the sensitive parts work

Reading these before reporting will usually tell you whether something is intended:

| Concern | Where |
|---|---|
| Credential sealing, master key rotation | `src/lib/server/secrets.ts` |
| Log redaction, and the test that proves it | `src/lib/server/logger.ts`, `tests/unit/secrets.test.ts` |
| Tenant scoping, state machine, charging once | `src/lib/server/repo.ts` |
| Approval gate and its one-time tokens | `src/lib/server/engine.ts` |
| Webhook signature verification | `src/app/api/webhooks/magnific/route.ts` |
| Asset serving and identifier checks | `src/app/api/assets/[id]/route.ts` |

## If you think a key has leaked

Revoke it first — **Developers → REVOKE** erases the stored ciphertext immediately and
cancels everything queued — then rotate it at magnific.com, then report.
