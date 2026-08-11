# Contributing

Thanks for looking. X-Forge is maintained by **Yurii S.** ([@yuriiss](https://github.com/yuriiss))
and released under the [PolyForm Noncommercial License 1.0.0](LICENSE) — contributions are
accepted under the same terms. By opening a pull request you agree that your contribution is
licensed that way too.

## Before you open a pull request

This project talks to a live, paid API. Two consequences shape everything here.

**Every change must keep the spending rules intact.** Credits are reserved before work
starts and charged exactly once; estimates come from the provider, not from a table; a job
whose fate is unknown goes to `needs_recon` rather than being re-run. If a change makes it
possible to charge twice, spend without an estimate, or silently retry after submission,
it will not be merged however elegant it is.

**Endpoint behaviour is pinned deliberately.** Several paths and field names in
`src/lib/server/magnific.ts` do not match the published reference — they were established by
running the API, and the comments say so. "Tidying" them toward the documentation breaks
them silently. If you believe one has changed, prove it with a live call and update the
comment along with the code.

## Working on it

```bash
npm install
npm run setup        # your own key; nothing is shared
npm run dev

npm run lint         # tsc --noEmit
npm run test:unit    # no network, no credits
npm run test:api     # live; spends ~20 credits
npm run test:e2e     # browser; needs the console running
```

Unit tests are the ones that must always pass and must never need a key. If you add a rule
to the engine, add the test that proves it — the existing suite in `tests/unit/engine.test.ts`
is the pattern to follow.

## Style

The codebase explains *why*, not *what*. Comments justify a decision, name a constraint, or
record something that cost time to discover; they do not narrate the line below them. If a
piece of code is surprising, the comment should say what would go wrong without it.

Match the surrounding file for everything else — naming, structure, formatting. There is no
linter enforcing style on purpose.

## Reporting things

- **Bugs** — an issue with the job's state transitions (Task Queue → click the row) is worth
  ten paragraphs of description.
- **Provider changes** — if Magnific alters an endpoint, please include the exact request and
  the exact response.
- **Security** — do not open an issue. See [`SECURITY.md`](SECURITY.md).

Never paste an API key, a token, or an unredacted log into an issue.
