# @marianmeres/bulk-email — Agent Guide

Folder-driven, idempotent mail-merge for **small** lists (single digits to low
tens): plain-text templates + CSV + `.env` in one directory, serial sends with a
delay, an append-only JSONL ledger that makes re-runs safe. Library + CLI.

## Quick Reference

- **Runtime:** Deno. **JSR:** core + Deno directory helpers + CLI. **npm:** core only.
- **JSR `exports` / CLI entry:** `src/main.ts` (re-exports `mod.ts` + `campaign-fs.ts`,
  `import.meta.main` guard runs `cli.ts`).
- **npm `.` entry:** `src/mod.ts` — pure re-exports, **no Deno globals, no `@std/*`**
  (compiled by plain `tsc` via `@marianmeres/npmbuild`).
- **Test:** `deno task test` (`deno test -A`; offline — includes a fake local SMTP server).
- **Check / Lint / Format:** `deno task check` | `deno task lint` | `deno fmt`.
- **Publish:** `deno task publish` runs `deno task preflight` first — it **refuses**
  while `deno.json` maps any dependency to a local path (`deno publish --dry-run` does
  not catch that). Use local paths only while co-developing a dependency.

## Architecture

```
recipients.csv ──parseRecipients──▶ Recipient[] ─┐
subject/body   ──(templates)──────────────────────┼─▶ planCampaign ──▶ Plan ──▶ runPlan ──▶ transport.send()
log.jsonl      ──loadLedgerState──▶ LedgerState ──┘        ▲                       │
                                                            │                       └──▶ appendLedger (sending → sent|error)
.env + process env ──resolveCampaignSettings / resolveSmtpOptions (send-email)
```

- **Core** (`mod.ts`, npm-safe): `types`, `recipients`, `template`, `ledger`,
  `settings`, `plan`, `run`. Pure or I/O-injected (`appendLedger`, `sleep`, `now`,
  `random`, `transport`).
- **Deno layer:** `campaign-fs.ts` (read dir, `.env`, ledger appender), `cli.ts`
  (`runCli(args, io)` — all side effects injectable via `CliIo`), `main.ts`.
- **Deps:** `@marianmeres/send-email` (transport + `SMTP_*` env vocabulary),
  `@marianmeres/interpolate` (templating), `@marianmeres/parse-csv` (CSV),
  `@marianmeres/cli-status-line` (CLI only; Deno-only, JSR-only).

## Project Structure

```
src/
  types.ts        all public types, ConfigError, DEFAULT_SETTINGS
  recipients.ts   parseRecipients, normalizeEmail, isPlausibleEmail
  template.ts     extract*Variables, assertStrictVariablesHaveColumns,
                  findEmptyStrictVariables, renderEmail
  ledger.ts       parse/serialize JSONL, buildLedgerState (sent › dangling › errors)
  settings.ts     resolveCampaignSettings (SMTP_FROM, SMTP_REPLY_TO, BCC, DELAY_MS, MAX_ATTEMPTS)
  plan.ts         planCampaign — statuses pending|retry|sent|gave-up|data-error|unknown
  run.ts          runPlan (serial loop), selectQueue, jitter, defaultSleep
  campaign-fs.ts  Deno: loadCampaign, loadLedger, createLedgerAppender, loadCampaignEnv, CAMPAIGN_FILES
  cli.ts          Deno: runCli — send | preview | status | verify | help | version
  mod.ts          npm entry (core)      main.ts  JSR entry (core + fs + CLI guard)
tests/
  *.test.ts       one per module; cli.test.ts uses injected io; e2e-smtp.test.ts runs the
                  real nodemailer transport against tests/_fake-smtp.ts on localhost
  _fixture.ts     temp campaign dir builder
scripts/
  build-npm.ts          npm core build (explicit sourceFiles)
  preflight-publish.ts  refuses to publish with local-path imports
examples/campaign/      runnable sample campaign (.env.example inside)
```

## Critical Conventions (hard invariants — enforce in review)

1. **Idempotency is the product.** Ledger key = normalized email. `sent` is final,
   whatever else the ledger says. Never key on template content. Never auto-retry an
   `unknown` (dangling `sending`) — a human resolves it.
2. **Write `sending` before `send()`, `sent`/`error` after.** Do not reorder; do not
   batch ledger writes. A crash must leave `unknown`, never a silent resend.
3. **Fail before spending.** Sender, every queued render, `verify()` — all before the
   first ledger write. Config problems are `ConfigError` → exit `2`, before the prompt.
4. **Strict variables by default.** A reference without a fallback operator must be a
   CSV column and non-empty per row. Keep `extractTemplateVariables` in sync with
   interpolate's grammar (`$$` escape, `${key}` literal-key-wins rule, uppercase-only
   unbraced names).
5. **Core stays runtime-agnostic.** Nothing in `mod.ts`'s import graph may touch
   `Deno.*`, `@std/*`, `node:*`, or `cli-status-line`. `scripts/build-npm.ts` lists the
   npm files explicitly — add new core files there.
6. **The CLI is the only layer that reads the ambient env / `.env`.** Library functions
   take an `EnvGetter`.
7. **`runCli` never calls `Deno.exit`** (except through injectable `exit` on the second
   Ctrl-C). All side effects go through `CliIo` so tests stay hermetic and offline.
8. **Secrets are never logged**; no `--user`/`--pass` flags. `SMTP_*` names are
   `send-email`'s — do not invent parallel ones.
9. **Explicit return types + JSDoc on every exported symbol** (JSR slow-type checks).
10. Malformed ledger line → `ConfigError`, never skip-and-continue.

## Before Making Changes

- [ ] New core file? Add it to `scripts/build-npm.ts` `sourceFiles`; run `deno task npm:build`.
- [ ] Touching the ledger format? Keep old lines parseable; extra keys are ignored by design.
- [ ] Changing a status or precedence in `plan.ts`? Update the table in README + API.md
      and `formatItemDetail` in `cli.ts`.
- [ ] Run `deno fmt`, `deno task lint`, `deno task check`, `deno task test`,
      `deno publish --dry-run --allow-dirty`.
- [ ] Public API changed? Update [README.md](README.md) and [API.md](API.md).

## Documentation

- [README.md](README.md) — human overview, campaign layout, CLI walkthrough, env table.
- [API.md](API.md) — full library + CLI reference.
- [examples/campaign](examples/campaign) — copy-and-edit starting point.
