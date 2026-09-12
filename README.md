# @marianmeres/bulk-email

[![NPM](https://img.shields.io/npm/v/@marianmeres/bulk-email)](https://www.npmjs.com/package/@marianmeres/bulk-email)
[![JSR](https://jsr.io/badges/@marianmeres/bulk-email)](https://jsr.io/@marianmeres/bulk-email)
[![License](https://img.shields.io/npm/l/@marianmeres/bulk-email)](LICENSE)

Send one hand-written email to a short list of people — from a **folder of plain
text files**, safely, one message at a time.

A campaign is a directory: a subject, a body, a CSV of recipients, an `.env`
with your SMTP settings. The tool interpolates the templates per row, sends
serially with a delay, and keeps an append-only ledger so that **re-running is
always safe**: nobody who has been sent is ever sent again, only failures are
retried, and only up to a limit.

Built for personal outreach at the scale of single digits to low tens of
messages. Not a newsletter system: no HTML editor, no tracking, no queue, no
database.

- **Idempotent by construction** — `log.jsonl` is the source of truth; a
  recipient marked `sent` is final. An interrupted send is flagged `unknown` and
  never silently retried.
- **Fails before it spends** — sender, every template render, and the SMTP
  handshake are all checked before the first message goes out.
- **Strict variables** — a `${NAME}` that is blank for a row blocks that row
  instead of sending "Dear ,".
- **Serial with jitter** — one connection, one message at a time, a configurable
  pause in between.
- **Ctrl-C safe** — the first press finishes the in-flight send and writes the
  ledger; the second quits.
- Library + CLI. SMTP via [`@marianmeres/send-email`](https://jsr.io/@marianmeres/send-email),
  templating via [`@marianmeres/interpolate`](https://jsr.io/@marianmeres/interpolate),
  CSV via [`@marianmeres/parse-csv`](https://jsr.io/@marianmeres/parse-csv), progress via
  [`@marianmeres/cli-status-line`](https://jsr.io/@marianmeres/cli-status-line).

## Installation

```bash
# Run the CLI with no install
deno run -A jsr:@marianmeres/bulk-email --help

# Or install it as a command
deno install -gA -n bulk-email jsr:@marianmeres/bulk-email

# As a library
deno add jsr:@marianmeres/bulk-email     # Deno: core + directory helpers + CLI
npm install @marianmeres/bulk-email      # npm: runtime-agnostic core only
```

## A campaign directory

```
2026-09-outreach/
  .env              SMTP_* + SMTP_FROM, optionally SMTP_REPLY_TO, BCC, DELAY_MS,
                    MAX_ATTEMPTS, PREVENT_THREADING
  subject.txt       Following up on our call about ${TOPIC}
  body.txt          Dear ${TITLE:-Mx.} ${NAME}, thank you for taking the time to talk ${WHEN}. …
  body.html         (optional) HTML alternative, same variables
  recipients.csv    EMAIL,NAME,TITLE,WHEN,TOPIC
                    alice@example.com,Alice,,on Tuesday,your onboarding
                    bob@example.com,Bob,Dr.,yesterday,the pricing options
  log.jsonl         written by the tool
```

Every CSV column is a template variable (`${NAME}`, `$NAME`). `EMAIL` is
required and is the recipient. A variable used **without a fallback** is strict:
it must be a column, and must be non-empty for every row that is sent. Use
`${TITLE:-Mx.}` to make one optional. Full syntax: see
[interpolate](https://jsr.io/@marianmeres/interpolate).

The `.env` is optional per campaign — process env always wins, and `--env-file`
points at a shared file when you don't want credentials next to templates. See
[.env.example](.env.example) and the runnable [examples/campaign](examples/campaign).

## CLI usage

```bash
# What would happen? (nothing is sent, no SMTP needed)
bulk-email status ./2026-09-outreach
bulk-email preview ./2026-09-outreach --to bob@example.com
bulk-email send ./2026-09-outreach --dry-run

# Check the SMTP credentials without sending
bulk-email verify ./2026-09-outreach

# Send to yourself first, look at it in your inbox …
bulk-email send ./2026-09-outreach --only me@example.com

# … then send the rest. Already-sent recipients are skipped automatically.
bulk-email send ./2026-09-outreach
```

`send` prints the plan and asks for confirmation (`-y` skips it; a non-terminal
without `-y` refuses). While running, a status line shows progress and a line
per recipient is printed above it:

```
Campaign: /…/2026-09-outreach
Recipients: 12 — 3 sent, 8 pending, 1 data-error
Send 8 emails as "Your Name <you@example.com>" via smtp.example.com:587? [y/N] y
✓ 1/8 alice@example.com  Following up on our call about your onboarding  (<id@example.com>)
✗ 2/8 bob@example.com  attempt 1: 451 4.7.0 Try again later
⠹ 0:14 · 1✓ 1✗ next: carol@example.com waiting 9 s
```

Re-run later: the failed one is retried (up to `MAX_ATTEMPTS`, default 3), the
sent ones are not touched. `status` shows where everyone stands:

| Status       | Meaning                                 | Next run |
| ------------ | --------------------------------------- | -------- |
| `pending`    | never attempted                         | sends    |
| `retry`      | failed before, under the attempt limit  | sends    |
| `sent`       | accepted by the SMTP server             | skips    |
| `gave-up`    | failed `MAX_ATTEMPTS` times             | skips    |
| `data-error` | a strict variable is blank for this row | skips    |
| `unknown`    | interrupted mid-send; outcome unknown   | skips    |

To force anything, edit `log.jsonl`: delete a recipient's lines and they are
`pending` again. The ledger is plain JSON lines, one per event.

Exit codes: `0` ok, `1` runtime failure (including any failed send), `2`
usage/config error. See [API.md](API.md#cli) for every flag.

## Environment

Read from `<dir>/.env` (or `--env-file`), overridden by the process env.

| Variable            | Required | Notes                                                                                                                                                                                                                                       |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`         | to send  | SMTP server. Plus `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SERVERNAME`, `SMTP_TLS_REJECT_UNAUTHORIZED`, timeouts — exactly as in [send-email](https://jsr.io/@marianmeres/send-email).                             |
| `SMTP_FROM`         | to send  | Sender, e.g. `Name <addr@example.com>`.                                                                                                                                                                                                     |
| `SMTP_REPLY_TO`     | no       | Reply-To header.                                                                                                                                                                                                                            |
| `BCC`               | no       | Added to every message — e.g. yourself, for a copy.                                                                                                                                                                                         |
| `DELAY_MS`          | no       | Pause between sends, ± 20 % jitter. Default `10000`.                                                                                                                                                                                        |
| `MAX_ATTEMPTS`      | no       | Failed attempts before giving up on a recipient. Default `3`.                                                                                                                                                                               |
| `PREVENT_THREADING` | no       | `true` gives every message a unique `References` and `X-Entity-Ref-ID` header, so Gmail does not group same-subject messages from you into one conversation (your `BCC` copies, a test send to several of your own addresses). Default off. |

## Library usage

The Deno/JSR package exposes the directory helpers and the core; the npm
package exposes the runtime-agnostic core only (bring your own file I/O).

```ts
import {
	createLedgerAppender,
	loadCampaign,
	loadCampaignEnv,
	loadLedger,
	planCampaign,
	resolveCampaignSettings,
	runPlan,
} from "@marianmeres/bulk-email";
import { createNodemailerTransport, resolveSmtpOptions } from "@marianmeres/send-email";

const dir = "./2026-09-outreach";
const env = await loadCampaignEnv(dir);
const settings = resolveCampaignSettings(env);
const campaign = await loadCampaign(dir);
const plan = planCampaign(campaign, await loadLedger(dir), settings.maxAttempts);

console.log(plan.counts); // { pending: 8, sent: 3, … }

const summary = await runPlan(plan, campaign.templates, {
	transport: createNodemailerTransport(resolveSmtpOptions(env)),
	settings,
	appendLedger: createLedgerAppender(dir),
	onEvent: (e) => console.log(e.type, "email" in e ? e.email : ""),
});
```

## API

See [API.md](API.md) for the complete library and CLI reference.

## License

[MIT](LICENSE)
