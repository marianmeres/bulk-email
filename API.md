# API

Public API of `@marianmeres/bulk-email`.

Two entry points:

- **JSR `@marianmeres/bulk-email`** (`src/main.ts`) — everything below: the
  runtime-agnostic core, the Deno-only [directory helpers](#directory-helpers-deno-only),
  and the [CLI](#cli) when run directly.
- **npm `@marianmeres/bulk-email`** (`src/mod.ts`) — the core only. No file
  I/O; you supply strings and an `appendLedger` function.

Errors are **thrown, never returned**. Anything a human has to fix in the
campaign directory or the environment is a [`ConfigError`](#configerror);
the CLI maps it to exit code `2`.

---

## Core functions

### `parseRecipients(text)`

Parses `recipients.csv`.

**Parameters:**

- `text` (`string`) — raw CSV. UTF-8, optional BOM, CRLF or LF, RFC 4180 quoting.

**Returns:** [`RecipientsParseResult`](#recipientsparseresult)

**Rules:** the header row must contain an `EMAIL` column (case-insensitive match,
trimmed). Every column becomes a variable in `Recipient.context`, values trimmed.
Addresses are normalized (trim + lower-case) for identity; the first occurrence
wins, later duplicates are reported in `skipped`. Rows with an implausible
address or nothing but blanks are also skipped and reported.

**Throws:** `ConfigError` — empty CSV, no `EMAIL` column, duplicate header names.

```ts
const { recipients, columns, skipped } = parseRecipients("EMAIL,NAME\na@x.com,Alice\n");
recipients[0]; // { email: "a@x.com", address: "a@x.com", row: 1, context: { EMAIL: "a@x.com", NAME: "Alice" } }
```

### `normalizeEmail(email)`

`string → string`. Trim + lower-case. The ledger key.

### `isPlausibleEmail(email)`

`string → boolean`. Deliberately loose: one `@`, something on both sides, a dot
in the domain, no whitespace. The SMTP server is the real authority.

---

### `extractTemplateVariables(template, columns?)`

Lists the variables a template references, in order of first appearance.

**Parameters:**

- `template` (`string`) — raw template text.
- `columns` (`readonly string[]`, optional) — known context keys. A braced
  expression that is _exactly_ a known key (e.g. `${my-var}`) resolves to that
  key, mirroring interpolate's "literal key wins" rule.

**Returns:** [`TemplateVariable[]`](#templatevariable) — one entry per name; a
name is `strict` if _any_ of its references lacks a fallback.

| Reference                       | `strict`         |
| ------------------------------- | ---------------- |
| `$NAME`, `${NAME}`              | `true`           |
| `${NAME:?msg}`, `${NAME?}`, `!` | `true`           |
| `${NAME:-x}`, `${NAME-x}`       | `false`          |
| `${NAME:+x}`, `${NAME+x}`       | `false`          |
| `$$`                            | escape — ignored |

### `extractCampaignVariables(templates, columns?)`

Same, merged across `subject`, `text` and `html`.

### `assertStrictVariablesHaveColumns(templates, columns)`

**Throws** `ConfigError` naming every strict variable that is not a CSV column.
Called by `planCampaign()`; call it yourself for early validation.

### `findEmptyStrictVariables(templates, recipient, columns)`

**Returns** `string[]` — the strict variables whose value is missing or blank for
this recipient. Non-empty → the recipient is a `data-error` in the plan.

### `renderEmail(templates, recipient, settings)`

Interpolates subject (collapsed to one line), text and html for one recipient.

**Returns:** [`RenderedEmail`](#renderedemail)

**Throws:** `ConfigError` — `settings.from` missing, or interpolate itself threw
(a `${VAR:?message}` assertion). The message is prefixed with `row N (email):`.

---

### `parseLedger(text)`

`string → LedgerEntry[]`. Blank lines ignored.

**Throws:** `ConfigError` on the first malformed line, with its line number.
Parsing is strict on purpose: guessing at a corrupt ledger is how a message is
sent twice.

### `parseLedgerLine(line, lineNo)`

One line. Validates `ts`, `email`, `status`, `attempt`; keeps `subject`, `id`,
`error`; ignores unknown keys; normalizes `email`.

### `serializeLedgerEntry(entry)`

`LedgerEntry → string`. One JSON object, fixed key order, no trailing newline.

### `buildLedgerState(entries)`

`LedgerEntry[] → LedgerState`. Indexes by recipient: a `sent` entry wins over
everything; `error` entries accumulate; a `sending` entry not followed by a
`sent`/`error` for the same recipient is _dangling_.

### `loadLedgerState(text)`

`parseLedger` + `buildLedgerState`.

---

### `resolveCampaignSettings(env, overrides?)`

Pure mapping from env-shaped values to [`CampaignSettings`](#campaignsettings).

**Parameters:**

- `env` (`EnvGetter` from `@marianmeres/send-email`) — `key → value | undefined`.
- `overrides` ([`SettingsOverrides`](#settingsoverrides), optional) — win over
  env; strings are parsed like env values.

| Key             | Field         | Default |
| --------------- | ------------- | ------- |
| `SMTP_FROM`     | `from`        | —       |
| `SMTP_REPLY_TO` | `replyTo`     | —       |
| `BCC`           | `bcc`         | —       |
| `DELAY_MS`      | `delayMs`     | `10000` |
| `MAX_ATTEMPTS`  | `maxAttempts` | `3`     |

Blank values count as unset. **Throws** `ConfigError` on a non-integer
`DELAY_MS` (must be ≥ 0) or `MAX_ATTEMPTS` (must be ≥ 1).

---

### `planCampaign(campaign, ledger, maxAttempts)`

Reconciles a campaign against its ledger.

**Parameters:**

- `campaign` ([`Campaign`](#campaign))
- `ledger` ([`LedgerState`](#ledgerstate))
- `maxAttempts` (`number`) — failed attempts after which a recipient is `gave-up`.

**Returns:** [`Plan`](#plan)

**Precedence per recipient:** `sent` › `unknown` › `gave-up` › `data-error` ›
`retry` › `pending`. Only `pending` and `retry` end up in `plan.queue`.

**Throws:** `ConfigError` when a strict template variable has no CSV column
(nothing else is checked first — a broken template is a campaign-level problem).

```ts
const plan = planCampaign(campaign, loadLedgerState(ledgerText), 3);
plan.counts; // { pending: 8, retry: 1, sent: 3, "gave-up": 0, "data-error": 1, unknown: 0 }
plan.queue.map((i) => i.recipient.email); // who a run would send to, in CSV order
```

### `selectQueue(plan, { only?, limit? })`

Narrows `plan.queue`: keep only the `only` addresses (normalized), then take the
first `limit`. An `only` address that is a recipient but not in the queue
(already sent, gave up, …) is silently left out — that is the idempotency.

**Throws:** `ConfigError` when an `only` address is not in `recipients.csv` at
all, or `limit` is not a non-negative integer.

### `runPlan(plan, templates, options)`

The serial send loop.

**Parameters:**

- `plan` ([`Plan`](#plan))
- `templates` ([`CampaignTemplates`](#campaigntemplates))
- `options` ([`RunOptions`](#runoptions))

**Returns:** `Promise<` [`RunSummary`](#runsummary) `>`

**Order of operations:**

1. `selectQueue()`; render **every** queued message (fail fast on sender /
   template problems — nothing has been touched yet).
2. `transport.verify()` if it exists and `verify !== false` (skipped on a dry
   run or an empty queue). A throw here aborts with nothing written.
3. Per recipient: append `sending` → `transport.send()` → append `sent` or
   `error` → emit event → wait `delayMs ± 20 %` unless last / aborted / dry run.

A send that throws is logged as `error` and the loop **continues**. If
`appendLedger` throws, the run aborts; a `sending` entry may be left dangling,
which the next plan reports as `unknown`.

**Abort:** when `options.signal` fires, the in-flight send completes and is
written, the delay is skipped, and the run returns with `aborted: true`.

**Throws:** `ConfigError` from step 1; whatever `verify()` throws in step 2;
whatever `appendLedger` throws.

### `jitter(baseMs, random?)`

`number → number`. `baseMs × (0.8 … 1.2)`, rounded; `0` stays `0`.

### `defaultSleep(ms, signal?)`

`setTimeout`-based sleep that resolves early when `signal` aborts.

---

## Directory helpers (Deno only)

Exported from the JSR package, not from npm.

### `loadCampaign(dir)`

Reads `subject.txt` (trimmed), `body.txt`, optional `body.html`, and
`recipients.csv`. **Returns** `Promise<` [`Campaign`](#campaign) `>`.
**Throws** `ConfigError` when the directory or a required file is missing, a
required template is blank, or the CSV is invalid.

### `loadLedger(dir)`

Reads `log.jsonl`; an absent file is an empty ledger. **Returns**
`Promise<LedgerState>`. **Throws** `ConfigError` on a corrupt line.

### `createLedgerAppender(dir)`

**Returns** `(entry: LedgerEntry) => Promise<void>` that appends one JSON line
to `log.jsonl` (created on first write). Pass as `RunOptions.appendLedger`.

### `loadCampaignEnv(dir, options?)`

Builds the `EnvGetter` for a campaign.

- `options.envFile` (`string`, optional) — explicit `.env` path. Replaces
  `<dir>/.env` and **must exist**. Default: `<dir>/.env`, loaded if present.
- `options.processEnv` (`EnvGetter`, optional) — default `Deno.env.get`.

**Precedence:** process env wins over the file, except that a present-but-blank
process value does not shadow a file value.

### `assertCampaignDir(dir)`

`Promise<string>` — the absolute path. **Throws** `ConfigError` when missing or
not a directory.

### `CAMPAIGN_FILES`

```ts
{ subject: "subject.txt", text: "body.txt", html: "body.html",
  recipients: "recipients.csv", ledger: "log.jsonl", env: ".env" }
```

---

## Types

### `ConfigError`

```ts
class ConfigError extends Error {
	name: "ConfigError";
}
```

Something in the campaign directory or the env must be fixed by a human. CLI
exit code `2`.

### `Recipient`

```ts
interface Recipient {
	email: string; // normalized (trim + lower-case) — the ledger key
	address: string; // as written in the CSV (trimmed) — used as To
	row: number; // 1-based data row (header not counted)
	context: Record<string, string>; // every column → trimmed value
}
```

### `SkippedRow` / `SkipReason`

```ts
type SkipReason = "duplicate" | "invalid-email" | "empty-row";
interface SkippedRow {
	row: number;
	reason: SkipReason;
	email?: string;
}
```

### `RecipientsParseResult`

```ts
interface RecipientsParseResult {
	recipients: Recipient[]; // unique, valid, CSV order
	columns: string[]; // trimmed header names
	skipped: SkippedRow[];
}
```

### `CampaignTemplates`

```ts
interface CampaignTemplates {
	subject: string;
	text: string;
	html?: string;
}
```

### `Campaign`

```ts
interface Campaign {
	templates: CampaignTemplates;
	recipients: Recipient[];
	columns: string[];
	skipped: SkippedRow[];
}
```

The output of `loadCampaign()`; or build it yourself from `parseRecipients()`
plus the template strings.

### `CampaignSettings`

```ts
interface CampaignSettings {
	from?: string; // required to send
	replyTo?: string;
	bcc?: string;
	delayMs: number; // default 10000
	maxAttempts: number; // default 3
}
```

### `SettingsOverrides`

```ts
interface SettingsOverrides {
	from?: string;
	replyTo?: string;
	bcc?: string;
	delayMs?: number | string;
	maxAttempts?: number | string;
}
```

### `TemplateVariable`

```ts
interface TemplateVariable {
	name: string;
	strict: boolean;
}
```

### `RenderedEmail`

```ts
interface RenderedEmail {
	to: string;
	from: string;
	subject: string;
	text: string;
	html?: string;
	replyTo?: string;
	bcc?: string;
}
```

### `LedgerEntry` / `LedgerStatus`

```ts
type LedgerStatus = "sending" | "sent" | "error";
interface LedgerEntry {
	ts: string; // ISO-8601
	email: string; // normalized
	status: LedgerStatus;
	attempt: number; // 1-based
	subject?: string; // on sent
	id?: string; // provider message id, on sent
	error?: string; // on error
}
```

One line of `log.jsonl` each, e.g.

```json
{"ts":"2026-09-09T10:00:00.000Z","email":"a@x.com","status":"sending","attempt":1}
{"ts":"2026-09-09T10:00:01.412Z","email":"a@x.com","status":"sent","attempt":1,"subject":"Hello Alice","id":"<…>"}
{"ts":"2026-09-09T10:00:12.008Z","email":"b@x.com","status":"error","attempt":1,"error":"451 4.7.0 Try again later"}
```

### `LedgerRecord` / `LedgerState`

```ts
interface LedgerRecord {
	sent?: LedgerEntry;
	errors: LedgerEntry[];
	dangling?: LedgerEntry;
}
interface LedgerState {
	entries: LedgerEntry[];
	records: Map<string, LedgerRecord>;
}
```

### `PlanStatus` / `PlanItem` / `Plan`

```ts
type PlanStatus = "pending" | "retry" | "sent" | "gave-up" | "data-error" | "unknown";

interface PlanItem {
	recipient: Recipient;
	status: PlanStatus;
	attempts: number; // prior failed attempts
	lastError?: string;
	sentEntry?: LedgerEntry; // when sent
	emptyVariables?: string[]; // when data-error
	danglingEntry?: LedgerEntry; // when unknown
}

interface Plan {
	items: PlanItem[]; // one per unique recipient, CSV order
	queue: PlanItem[]; // pending + retry
	counts: Record<PlanStatus, number>;
	skipped: SkippedRow[];
}
```

### `RunOptions`

```ts
interface RunOptions {
	transport: EmailTransport; // @marianmeres/send-email; createMockTransport() for dry runs
	settings: CampaignSettings; // from is required
	appendLedger: (entry: LedgerEntry) => Promise<void>; // never called on a dry run
	limit?: number;
	only?: string[];
	dryRun?: boolean; // no ledger writes, no delays, no verify
	onEvent?: (event: RunEvent) => void;
	verify?: boolean; // default true
	signal?: AbortSignal; // cooperative stop
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; // tests
	now?: () => Date; // tests
	random?: () => number; // tests
}
```

### `RunEvent`

```ts
type RunEvent =
	| { type: "verifying" }
	| { type: "start"; total: number }
	| { type: "sending"; email: string; index: number; total: number; attempt: number }
	| {
		type: "sent";
		email: string;
		index: number;
		total: number;
		id: string;
		subject: string;
	}
	| {
		type: "error";
		email: string;
		index: number;
		total: number;
		attempt: number;
		error: string;
		gaveUp: boolean;
	}
	| { type: "waiting"; ms: number; index: number; total: number }
	| { type: "aborted"; index: number; total: number }
	| { type: "done"; summary: RunSummary };
```

`index` is 1-based and refers to the position in this run's queue.

### `RunSummary`

```ts
interface RunSummary {
	sent: number;
	errors: number;
	total: number; // queue size for this run
	aborted: boolean;
	dryRun: boolean;
}
```

### `CliIo`

Injectable collaborators for `runCli()`. Every field optional; defaults are the
real thing (`console.log`, `Deno.env.get`, the global `confirm()`,
`createNodemailerTransport`, `statusLine`, `Deno.addSignalListener`, `Deno.exit`).

```ts
interface CliIo {
	out?: (line: string) => void;
	err?: (line: string) => void;
	env?: EnvGetter;
	isInteractive?: () => boolean;
	confirm?: (question: string) => boolean;
	createTransport?: (options: NodemailerTransportOptions) => EmailTransport;
	statusLine?: (options: StatusLineOptions) => StatusLine;
	onInterrupt?: (handler: () => void) => () => void;
	exit?: (code: number) => void;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
```

---

## Constants

### `DEFAULT_SETTINGS`

`{ delayMs: 10000, maxAttempts: 3 }` (frozen).

---

## CLI

```bash
deno run -A jsr:@marianmeres/bulk-email <command> <campaign-dir> [options]
```

`runCli(args, io?)` is also exported from `src/cli.ts` (`Promise<number>`; never
calls `Deno.exit` except through the injectable `exit` on a second Ctrl-C).

### Commands

| Command         | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `send <dir>`    | Print the plan, confirm, send the queue serially, write the ledger.         |
| `preview <dir>` | Render the message for one recipient (`--to`, default: first row). No SMTP. |
| `status <dir>`  | Print the plan: counts, per-recipient status, skipped CSV rows. No SMTP.    |
| `verify <dir>`  | SMTP connect + auth handshake only. Nothing is sent.                        |
| `help`          | Usage. Also `--help` / `-h`.                                                |
| `version`       | Package version. Also `--version`.                                          |

### `send` flags

| Flag                 | Effect                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`          | Mock transport. Renders and "sends" everything; no SMTP, no ledger writes, no delays, no prompt.                       |
| `--limit <n>`        | Send at most `n` this run.                                                                                             |
| `--only <addr>`      | Only these recipients. Repeatable or comma-separated. Must be in the CSV; already-sent ones are explained and skipped. |
| `--delay <ms>`       | Overrides `DELAY_MS`.                                                                                                  |
| `--max-attempts <n>` | Overrides `MAX_ATTEMPTS`.                                                                                              |
| `--no-verify`        | Skip the SMTP handshake before the first send.                                                                         |
| `-y`, `--yes`        | Skip the confirmation prompt. **Required** when stdin/stdout is not a terminal.                                        |
| `--json`             | One JSON object on stdout at the end; disables the status line and transcript.                                         |
| `--env-file <path>`  | Load this `.env` instead of `<dir>/.env` (must exist). Also for `preview`/`status`/`verify`.                           |

### `preview` flags

| Flag          | Effect                                                    |
| ------------- | --------------------------------------------------------- |
| `--to <addr>` | Recipient to render (default: the first CSV row).         |
| `--json`      | `{ ok, status, emptyVariables?, message: RenderedEmail }` |

### Behaviour

- **Order in `send`:** load → plan → resolve SMTP options and sender (config
  errors exit `2` _before_ the prompt) → print plan → confirm → verify → send.
- **Confirmation:** `Send N emails as "<from>" via <host>:<port>? [y/N]`.
  Declining prints `Aborted, nothing sent.` and exits `0`.
- **Ctrl-C:** first press → the in-flight send finishes and is written to the
  ledger, then the run stops (`aborted`, exit per results). Second press → exit
  `130` immediately.
- **Status line** (`@marianmeres/cli-status-line`): spinner, clock, `✓`/`✗`
  counters, current recipient, `waiting N s`. Off automatically when stdout is
  not a TTY (a plain line per recipient is still printed) and with `--json`.
- **`--json` shapes:**
  - `send`: `{ ok, dir, sent, errors, total, aborted, dryRun, results: [{ email, status, id?, error? }] }`
  - `status`: `{ ok, dir, counts, skipped, items: [{ email, address, row, status, attempts, lastError?, sentAt?, id?, emptyVariables?, interruptedAt? }] }`
  - `verify`: `{ ok, transport, host }`
  - any failure: `{ ok: false, error }` on stderr.

### Exit codes

| Code | Meaning                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success, including "nothing to send" and a declined confirmation.                                                               |
| `1`  | Runtime failure: SMTP verify failed, **or at least one send failed**.                                                           |
| `2`  | Usage/config error: bad flag, missing dir/file, bad CSV/ledger/template, missing `SMTP_HOST`/`SMTP_FROM`, non-TTY without `-y`. |
