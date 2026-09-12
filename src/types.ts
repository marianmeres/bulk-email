/**
 * Core types for `@marianmeres/bulk-email`.
 *
 * A **campaign** is a directory of plain-text files: a subject template, a
 * body template (text, optionally HTML too), a CSV of recipients, and a
 * tool-written JSONL **ledger** that makes re-runs idempotent. Everything here
 * is runtime-agnostic — file I/O lives in the Deno-only modules.
 *
 * @module
 */

import type { EmailTransport } from "@marianmeres/send-email";

// Re-exported so this package's public API is fully documented on its own.
export type {
	EmailAttachment,
	EmailTransport,
	EnvGetter,
	SendOptions,
	SendResult,
} from "@marianmeres/send-email";

/**
 * A configuration / campaign-data error: something in the campaign directory
 * (or the env) must be fixed by a human before a run can proceed. CLIs map it
 * to the usage exit code (`2`), as opposed to runtime failures (`1`).
 */
export class ConfigError extends Error {
	/**
	 * Creates a configuration error.
	 *
	 * @param message - What is wrong and, ideally, how to fix it.
	 */
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** One recipient row from `recipients.csv`, ready to be rendered and sent. */
export interface Recipient {
	/**
	 * Normalized address — trimmed and lower-cased. This is the ledger key:
	 * two rows normalizing to the same value are the same recipient.
	 */
	email: string;
	/** The address as written in the CSV (trimmed, case preserved) — used as `To`. */
	address: string;
	/** 1-based data-row number (the header row is not counted). */
	row: number;
	/**
	 * Interpolation context: every CSV column (trimmed header name) mapped to
	 * that row's trimmed value. The `EMAIL` column is included as written.
	 */
	context: Record<string, string>;
}

/** Why a CSV data row was not turned into a {@link Recipient}. */
export type SkipReason = "duplicate" | "invalid-email" | "empty-row";

/** A CSV data row that was skipped during parsing. */
export interface SkippedRow {
	/** 1-based data-row number. */
	row: number;
	/** Why the row was skipped. */
	reason: SkipReason;
	/** The offending (raw) address, when there was one. */
	email?: string;
}

/** Result of parsing `recipients.csv`. */
export interface RecipientsParseResult {
	/** Unique, valid recipients in CSV order. */
	recipients: Recipient[];
	/** Trimmed header names, in CSV order. Always contains `EMAIL`. */
	columns: string[];
	/** Rows that were not usable, with the reason. */
	skipped: SkippedRow[];
}

/** The templates of a campaign, as raw (un-interpolated) strings. */
export interface CampaignTemplates {
	/** `subject.txt`. Interpolated; rendered as a single line. */
	subject: string;
	/** `body.txt`. Interpolated plain-text body. */
	text: string;
	/** `body.html`, when present. Interpolated HTML body. */
	html?: string;
}

/** A fully-loaded campaign: templates plus the parsed recipient list. */
export interface Campaign {
	/** Raw subject / text / optional html templates. */
	templates: CampaignTemplates;
	/** Unique, valid recipients in CSV order. */
	recipients: Recipient[];
	/** Trimmed CSV header names. */
	columns: string[];
	/** CSV rows that were not usable. */
	skipped: SkippedRow[];
}

/**
 * Campaign-level settings — everything that is not the SMTP transport itself.
 * Resolved from env-shaped values by `resolveCampaignSettings()`; overridable
 * per invocation (CLI flags).
 */
export interface CampaignSettings {
	/** Sender, e.g. `"Your Name <you@example.com>"`. Env `SMTP_FROM`. Required to send. */
	from?: string;
	/** Reply-To. Env `SMTP_REPLY_TO`. */
	replyTo?: string;
	/** BCC added to every message (e.g. yourself, for a copy). Env `BCC`. */
	bcc?: string;
	/**
	 * Give every send a fresh, unique `References` and `X-Entity-Ref-ID` header so
	 * Gmail does not group same-subject messages from the same sender into one
	 * conversation. Env `PREVENT_THREADING`. Default **on** — omitted counts as
	 * on; only an explicit `false` lets threading happen.
	 */
	preventThreading?: boolean;
	/** Base delay between consecutive sends, in ms. Env `DELAY_MS`. Default `10000`. */
	delayMs: number;
	/**
	 * Maximum number of failed attempts per recipient before the tool gives up
	 * on them. Env `MAX_ATTEMPTS`. Default `3`.
	 */
	maxAttempts: number;
}

/** Default {@link CampaignSettings} values. */
export const DEFAULT_SETTINGS: Readonly<
	Required<Pick<CampaignSettings, "delayMs" | "maxAttempts" | "preventThreading">>
> = Object.freeze({
	delayMs: 10_000,
	maxAttempts: 3,
	preventThreading: true,
});

/**
 * Ledger entry status.
 *
 * - `sending` — written immediately *before* the SMTP call. If it is the last
 *   word on a recipient, the process died mid-send and the outcome is unknown.
 * - `sent` — the SMTP server accepted the message.
 * - `error` — the SMTP call threw. Counts as one failed attempt.
 */
export type LedgerStatus = "sending" | "sent" | "error";

/** One line of `log.jsonl`. */
export interface LedgerEntry {
	/** ISO-8601 timestamp. */
	ts: string;
	/** Normalized recipient address (see {@link Recipient.email}). */
	email: string;
	/** What happened. */
	status: LedgerStatus;
	/** 1-based attempt number for this recipient. */
	attempt: number;
	/** Rendered subject (on `sent`), for a human-readable record. */
	subject?: string;
	/** Provider message id (on `sent`). */
	id?: string;
	/** Error message (on `error`). */
	error?: string;
}

/** Per-recipient view derived from the ledger. */
export interface LedgerRecord {
	/** The `sent` entry, if any. */
	sent?: LedgerEntry;
	/** All `error` entries, in ledger order. */
	errors: LedgerEntry[];
	/**
	 * A `sending` entry not followed by a `sent`/`error` for the same
	 * recipient — the run was interrupted mid-send.
	 */
	dangling?: LedgerEntry;
}

/** The ledger, indexed by normalized email. */
export interface LedgerState {
	/** Every parsed entry, in file order. */
	entries: LedgerEntry[];
	/** Per-recipient records. */
	records: Map<string, LedgerRecord>;
}

/**
 * What a run would do with a recipient.
 *
 * - `pending` — never attempted; will be sent.
 * - `retry` — failed before, under `maxAttempts`; will be sent.
 * - `sent` — already delivered; skipped forever.
 * - `gave-up` — `maxAttempts` failures; skipped until the ledger is edited.
 * - `data-error` — a strict template variable is empty for this row; skipped
 *   until the CSV is fixed.
 * - `unknown` — a dangling `sending` entry; skipped until a human resolves it
 *   in the ledger.
 */
export type PlanStatus =
	| "pending"
	| "retry"
	| "sent"
	| "gave-up"
	| "data-error"
	| "unknown";

/** One recipient's place in a {@link Plan}. */
export interface PlanItem {
	/** The recipient. */
	recipient: Recipient;
	/** What a run would do with them. */
	status: PlanStatus;
	/** Prior failed attempts (from the ledger). */
	attempts: number;
	/** Last error message, when `attempts > 0`. */
	lastError?: string;
	/** The `sent` ledger entry, when `status === "sent"`. */
	sentEntry?: LedgerEntry;
	/** For `data-error`: the empty strict variables. */
	emptyVariables?: string[];
	/** For `unknown`: the dangling `sending` entry. */
	danglingEntry?: LedgerEntry;
}

/** The result of reconciling a campaign against its ledger. */
export interface Plan {
	/** One item per unique recipient, in CSV order. */
	items: PlanItem[];
	/** Items a run would send (`pending` + `retry`), in CSV order. */
	queue: PlanItem[];
	/** Count per status. */
	counts: Record<PlanStatus, number>;
	/** CSV rows skipped during parsing (duplicates, invalid addresses, blanks). */
	skipped: SkippedRow[];
}

/** A rendered, ready-to-send message for one recipient. */
export interface RenderedEmail {
	/** Recipient address as written in the CSV. */
	to: string;
	/** Sender. */
	from: string;
	/** Rendered, single-line subject. */
	subject: string;
	/** Rendered plain-text body. */
	text: string;
	/** Rendered HTML body, when the campaign has `body.html`. */
	html?: string;
	/** Reply-To, when configured. */
	replyTo?: string;
	/** BCC, when configured. */
	bcc?: string;
}

/** Progress events emitted by `runPlan()`. */
export type RunEvent =
	| { type: "verifying" }
	| { type: "start"; total: number }
	| {
		type: "sending";
		email: string;
		index: number;
		total: number;
		attempt: number;
	}
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

/** Final tally of a run. */
export interface RunSummary {
	/** Messages accepted by the transport. */
	sent: number;
	/** Messages whose send threw. */
	errors: number;
	/** Recipients that were in the queue for this run. */
	total: number;
	/** `true` when the run stopped early because of the abort signal. */
	aborted: boolean;
	/** `true` when nothing was really sent or written. */
	dryRun: boolean;
}

/** Options for `runPlan()`. */
export interface RunOptions {
	/** The transport to send through. Use `createMockTransport()` for a dry run. */
	transport: EmailTransport;
	/** Campaign settings; `from` is required. */
	settings: CampaignSettings;
	/**
	 * Appends one entry to the ledger. Called for `sending`, `sent` and
	 * `error`. Never called when `dryRun` is set.
	 */
	appendLedger: (entry: LedgerEntry) => Promise<void>;
	/** Send at most this many messages this run. */
	limit?: number;
	/**
	 * Restrict the run to these recipients (normalized addresses). Recipients
	 * that are not in the queue (already sent, gave up, …) stay skipped.
	 */
	only?: string[];
	/** Render + "send" through the transport but never write the ledger or wait. */
	dryRun?: boolean;
	/** Progress callback. */
	onEvent?: (event: RunEvent) => void;
	/**
	 * Call `transport.verify()` (when it exists) before the first send, so an
	 * auth/connection problem aborts the run instead of logging one error per
	 * recipient. Default `true`. Ignored on a dry run.
	 */
	verify?: boolean;
	/**
	 * Cooperative stop. When aborted, the run finishes the in-flight send
	 * (and its ledger write), skips the delay, and returns with
	 * `summary.aborted === true`.
	 */
	signal?: AbortSignal;
	/** Injectable sleep (tests). Default: `setTimeout`. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Injectable clock (tests). Default: `() => new Date()`. */
	now?: () => Date;
	/** Injectable RNG in `[0, 1)` for delay jitter (tests). Default: `Math.random`. */
	random?: () => number;
}
