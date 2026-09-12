/**
 * First-class CLI for `@marianmeres/bulk-email`.
 *
 * ```bash
 * deno run -A jsr:@marianmeres/bulk-email send ./my-campaign
 * deno run -A jsr:@marianmeres/bulk-email status ./my-campaign
 * ```
 *
 * All logic lives in {@link runCli}, which takes an args array and returns an
 * exit code (it never calls `Deno.exit`), so it is testable without spawning
 * a process. Everything external — stdout/stderr, process env, the
 * confirmation prompt, the SMTP transport, the status line, SIGINT — is
 * injectable via {@link CliIo}.
 *
 * **This is the only layer that reads the ambient environment.**
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import {
	type StatusLine,
	statusLine,
	type StatusLineOptions,
} from "@marianmeres/cli-status-line";
import {
	createMockTransport,
	createNodemailerTransport,
	type EmailTransport,
	type EnvGetter,
	type NodemailerTransportOptions,
	resolveSmtpOptions,
	SmtpEnvError,
} from "@marianmeres/send-email";
import denoJson from "../deno.json" with { type: "json" };
import {
	assertCampaignDir,
	createLedgerAppender,
	loadCampaign,
	loadCampaignEnv,
	loadLedger,
} from "./campaign-fs.ts";
import { planCampaign } from "./plan.ts";
import { normalizeEmail } from "./recipients.ts";
import { runPlan, selectQueue } from "./run.ts";
import { resolveCampaignSettings } from "./settings.ts";
import { renderEmail } from "./template.ts";
import {
	type Campaign,
	type CampaignSettings,
	ConfigError,
	type Plan,
	type PlanItem,
	type PlanStatus,
	type RunEvent,
	type RunSummary,
} from "./types.ts";

/** Package version, read from `deno.json` (works when published to JSR). */
const VERSION: string = denoJson.version;

/** Injectable collaborators for {@link runCli}. Every field is optional. */
export interface CliIo {
	/** stdout line writer. Default: `console.log`. */
	out?: (line: string) => void;
	/** stderr line writer. Default: `console.error`. */
	err?: (line: string) => void;
	/** Process-env getter. Default: `Deno.env.get`. */
	env?: EnvGetter;
	/** Whether stdin *and* stdout are a terminal. Default: probes `Deno.stdin`/`Deno.stdout`. */
	isInteractive?: () => boolean;
	/** Yes/no prompt. Default: the global `confirm()`. */
	confirm?: (question: string) => boolean;
	/** SMTP transport factory. Default: `createNodemailerTransport`. */
	createTransport?: (options: NodemailerTransportOptions) => EmailTransport;
	/** Status-line factory. Default: `statusLine` from `@marianmeres/cli-status-line`. */
	statusLine?: (options: StatusLineOptions) => StatusLine;
	/**
	 * Registers a SIGINT handler; returns the unsubscribe. Default:
	 * `Deno.addSignalListener`. Tests inject a no-op.
	 */
	onInterrupt?: (handler: () => void) => () => void;
	/** Hard exit used on the *second* Ctrl-C. Default: `Deno.exit`. */
	exit?: (code: number) => void;
	/** Injectable sleep, forwarded to the run loop (tests). */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Fully-resolved {@link CliIo}. */
interface ResolvedIo {
	out: (line: string) => void;
	err: (line: string) => void;
	env: EnvGetter;
	isInteractive: () => boolean;
	confirm: (question: string) => boolean;
	createTransport: (options: NodemailerTransportOptions) => EmailTransport;
	statusLine: (options: StatusLineOptions) => StatusLine;
	onInterrupt: (handler: () => void) => () => void;
	exit: (code: number) => void;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Signals a usage error → exit code `2`. */
class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** The `--help` / `help` text. */
const HELP: string = `
bulk-email v${VERSION} — send a hand-written email to a short list, safely, from a folder.

Usage:
  deno run -A jsr:@marianmeres/bulk-email <command> <campaign-dir> [options]

Commands:
  send <dir>      Send to everyone not yet sent (serial, delayed, ledger-backed).
  preview <dir>   Render the message for one recipient and print it.
  status <dir>    Show who is sent / pending / failed, without sending.
  verify <dir>    SMTP connect + auth handshake only; nothing is sent.
  help            Show this help. Also --help / -h.
  version         Print the package version. Also --version.

Campaign directory:
  subject.txt      Subject template.
  body.txt         Plain-text body template.
  body.html        Optional HTML body template (sent alongside body.txt).
  recipients.csv   Header row with an EMAIL column; every column is a template variable.
  .env             SMTP_* transport settings + campaign settings (optional).
  log.jsonl        Written by the tool. The ledger: nobody in it as "sent" is ever sent again.

Templates use \${VAR} / $VAR (@marianmeres/interpolate). A variable without a
fallback is strict: it must be a CSV column and non-empty for every recipient.
Use \${VAR:-fallback} to make one optional.

send options:
  --dry-run             Render + mock-send; no SMTP, no ledger writes, no delays.
  --limit <n>           Send at most n messages this run.
  --only <addr>         Send only to this recipient. Repeatable / comma-separated.
  --delay <ms>          Base delay between sends (± 20 % jitter). Env DELAY_MS. Default 10000.
  --max-attempts <n>    Give up on a recipient after n failed attempts. Env MAX_ATTEMPTS. Default 3.
  --no-verify           Skip the SMTP handshake before the first send.
  -y, --yes             Do not ask for confirmation.
  --json                Machine-readable output (also disables the status line).
  --env-file <path>     .env to load instead of <dir>/.env (must exist).

preview options:
  --to <addr>           Recipient to render (default: the first row).
  --json                Print the rendered message as JSON.

Environment (process env wins over the .env file):
  SMTP_HOST (required to send), SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
  SMTP_FROM (required to send), SMTP_REPLY_TO, SMTP_SERVERNAME,
  SMTP_TLS_REJECT_UNAUTHORIZED, SMTP_CONNECTION_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS,
  BCC, DELAY_MS, MAX_ATTEMPTS, PREVENT_THREADING.

Exit codes: 0 ok, 1 runtime failure (including any failed send), 2 usage/config error.
`.trim();

/** Fills in defaults for omitted collaborators. */
function resolveIo(io: CliIo): ResolvedIo {
	return {
		out: io.out ?? ((line: string) => console.log(line)),
		err: io.err ?? ((line: string) => console.error(line)),
		env: io.env ?? ((key: string) => Deno.env.get(key)),
		isInteractive: io.isInteractive ?? (() => {
			try {
				return Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
			} catch {
				return false;
			}
		}),
		confirm: io.confirm ?? ((q: string) => confirm(q)),
		createTransport: io.createTransport ?? createNodemailerTransport,
		statusLine: io.statusLine ?? statusLine,
		onInterrupt: io.onInterrupt ?? ((handler) => {
			Deno.addSignalListener("SIGINT", handler);
			return () => Deno.removeSignalListener("SIGINT", handler);
		}),
		exit: io.exit ?? ((code: number) => Deno.exit(code)),
		sleep: io.sleep,
	};
}

// deno-lint-ignore no-explicit-any -- parseArgs returns a loosely-typed bag.
type ParsedArgs = Record<string, any>;

/** Flattens a repeatable/comma-separated flag into a clean list. */
function collectAddresses(value: unknown): string[] {
	if (value === undefined) return [];
	const items = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const item of items) {
		for (const part of String(item).split(",")) {
			const trimmed = part.trim();
			if (trimmed) out.push(trimmed);
		}
	}
	return out;
}

/** Parses an optional non-negative integer flag. */
function intFlag(value: unknown, name: string): number | undefined {
	if (value === undefined || value === "") return undefined;
	const s = String(value).trim();
	if (!/^\d+$/.test(s)) throw new UsageError(`${name} must be a non-negative integer`);
	return Number(s);
}

/** Everything the campaign commands share: env, settings, campaign, ledger, plan. */
interface Loaded {
	dir: string;
	env: EnvGetter;
	settings: CampaignSettings;
	campaign: Campaign;
	plan: Plan;
}

async function loadAll(parsed: ParsedArgs, io: ResolvedIo): Promise<Loaded> {
	const dirArg = parsed._[1] !== undefined ? String(parsed._[1]) : undefined;
	if (!dirArg) throw new UsageError("a campaign directory is required");
	const dir = await assertCampaignDir(dirArg);
	const envFile = typeof parsed["env-file"] === "string"
		? parsed["env-file"]
		: undefined;
	const env = await loadCampaignEnv(dir, { envFile, processEnv: io.env });
	const settings = resolveCampaignSettings(env, {
		delayMs: intFlag(parsed.delay, "--delay"),
		maxAttempts: intFlag(parsed["max-attempts"], "--max-attempts"),
	});
	const campaign = await loadCampaign(dir);
	const ledger = await loadLedger(dir);
	const plan = planCampaign(campaign, ledger, settings.maxAttempts);
	return { dir, env, settings, campaign, plan };
}

// --- formatting ------------------------------------------------------------

const STATUS_GLYPH: Record<PlanStatus, string> = {
	sent: "✓",
	pending: "·",
	retry: "↻",
	"gave-up": "✗",
	"data-error": "!",
	unknown: "?",
};

/** `2026-09-09T10:00:00.000Z` → `2026-09-09 10:00`. */
function shortTs(iso: string): string {
	return iso.replace("T", " ").slice(0, 16);
}

function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function formatSkipped(plan: Plan): string[] {
	if (plan.skipped.length === 0) return [];
	const parts = plan.skipped.map((s) => {
		const what = s.reason === "duplicate"
			? `duplicate of ${s.email}`
			: s.reason === "invalid-email"
			? `invalid email "${s.email}"`
			: "empty row";
		return `row ${s.row} ${what}`;
	});
	return [`Skipped CSV rows: ${parts.join("; ")}`];
}

function formatCounts(plan: Plan): string {
	const order: PlanStatus[] = [
		"sent",
		"pending",
		"retry",
		"gave-up",
		"data-error",
		"unknown",
	];
	return order
		.filter((s) => plan.counts[s] > 0)
		.map((s) => `${plan.counts[s]} ${s}`)
		.join(", ");
}

function formatItemDetail(item: PlanItem): string {
	switch (item.status) {
		case "sent":
			return `${shortTs(item.sentEntry!.ts)}  ${item.sentEntry!.subject ?? ""}`
				.trimEnd();
		case "retry":
		case "gave-up":
			return `${item.attempts}× error: ${item.lastError ?? ""}`;
		case "data-error":
			return `empty: ${item.emptyVariables!.join(", ")}`;
		case "unknown":
			return `interrupted mid-send ${
				shortTs(item.danglingEntry!.ts)
			} — check your Sent folder, then delete or fix its lines in log.jsonl`;
		default:
			return "";
	}
}

function formatStatus(loaded: Loaded): string {
	const { plan, dir, settings } = loaded;
	const lines = [
		`Campaign: ${dir}`,
		`Recipients: ${plan.items.length} — ${formatCounts(plan) || "none"}` +
		` (max ${plural(settings.maxAttempts, "attempt")} per recipient)`,
		...formatSkipped(plan),
	];
	if (plan.items.length > 0) {
		lines.push("");
		const width = Math.max(...plan.items.map((i) => i.recipient.address.length));
		for (const item of plan.items) {
			const detail = formatItemDetail(item);
			lines.push(
				`  ${STATUS_GLYPH[item.status]} ${item.status.padEnd(10)} ${
					item.recipient.address.padEnd(width)
				}${detail ? `  ${detail}` : ""}`.trimEnd(),
			);
		}
	}
	return lines.join("\n");
}

function planToJson(plan: Plan): unknown {
	return {
		counts: plan.counts,
		skipped: plan.skipped,
		items: plan.items.map((i) => ({
			email: i.recipient.email,
			address: i.recipient.address,
			row: i.recipient.row,
			status: i.status,
			attempts: i.attempts,
			...(i.lastError !== undefined ? { lastError: i.lastError } : {}),
			...(i.sentEntry ? { sentAt: i.sentEntry.ts, id: i.sentEntry.id } : {}),
			...(i.emptyVariables ? { emptyVariables: i.emptyVariables } : {}),
			...(i.danglingEntry ? { interruptedAt: i.danglingEntry.ts } : {}),
		})),
	};
}

// --- commands -------------------------------------------------------------

async function handleStatus(parsed: ParsedArgs, io: ResolvedIo): Promise<number> {
	const loaded = await loadAll(parsed, io);
	if (parsed.json === true) {
		io.out(
			JSON.stringify({
				ok: true,
				dir: loaded.dir,
				...(planToJson(loaded.plan) as object),
			}),
		);
	} else {
		io.out(formatStatus(loaded));
	}
	return 0;
}

async function handlePreview(parsed: ParsedArgs, io: ResolvedIo): Promise<number> {
	const loaded = await loadAll(parsed, io);
	const { campaign, plan, settings } = loaded;
	if (campaign.recipients.length === 0) {
		throw new ConfigError("recipients.csv has no usable rows");
	}
	const to = typeof parsed.to === "string" && parsed.to.trim() !== ""
		? normalizeEmail(parsed.to)
		: campaign.recipients[0].email;
	const item = plan.items.find((i) => i.recipient.email === to);
	if (!item) throw new ConfigError(`--to: not in recipients.csv: ${to}`);

	const rendered = renderEmail(campaign.templates, item.recipient, {
		...settings,
		from: settings.from ?? "<SMTP_FROM not set>",
	});

	if (parsed.json === true) {
		io.out(JSON.stringify({
			ok: true,
			status: item.status,
			...(item.emptyVariables ? { emptyVariables: item.emptyVariables } : {}),
			preventThreading: settings.preventThreading !== false,
			message: rendered,
		}));
		return 0;
	}

	const lines = [
		`To:       ${rendered.to}`,
		`From:     ${rendered.from}`,
	];
	if (rendered.replyTo) lines.push(`Reply-To: ${rendered.replyTo}`);
	if (rendered.bcc) lines.push(`Bcc:      ${rendered.bcc}`);
	lines.push(
		settings.preventThreading !== false
			? "Headers:  unique References + X-Entity-Ref-ID per send (no Gmail threading)"
			: "Headers:  none added (PREVENT_THREADING=false — Gmail may thread sends)",
	);
	lines.push(`Subject:  ${rendered.subject}`);
	lines.push(
		`Status:   ${item.status}${
			item.emptyVariables ? ` (empty: ${item.emptyVariables.join(", ")})` : ""
		}`,
	);
	lines.push("", rendered.text.trimEnd());
	if (rendered.html !== undefined) {
		lines.push(
			"",
			`--- html (${rendered.html.length} chars) ---`,
			rendered.html.trimEnd(),
		);
	}
	io.out(lines.join("\n"));
	return 0;
}

async function handleVerify(parsed: ParsedArgs, io: ResolvedIo): Promise<number> {
	const dirArg = parsed._[1] !== undefined ? String(parsed._[1]) : undefined;
	if (!dirArg) throw new UsageError("a campaign directory is required");
	const dir = await assertCampaignDir(dirArg);
	const envFile = typeof parsed["env-file"] === "string"
		? parsed["env-file"]
		: undefined;
	const env = await loadCampaignEnv(dir, { envFile, processEnv: io.env });
	const options = resolveSmtpOptions(env);
	const transport = io.createTransport(options);
	if (typeof transport.verify !== "function") {
		io.out(
			parsed.json === true
				? JSON.stringify({
					ok: true,
					transport: transport.name,
					supported: false,
				})
				: `verification not supported by ${transport.name}`,
		);
		return 0;
	}
	await transport.verify();
	io.out(
		parsed.json === true
			? JSON.stringify({ ok: true, transport: transport.name, host: options.host })
			: `✅ ${transport.name}: connection + auth OK (${options.host}:${options.port})`,
	);
	return 0;
}

/** Explains why an `--only` address will not be sent this run. */
function explainOnlySkips(plan: Plan, only: string[], queue: PlanItem[]): string[] {
	const queued = new Set(queue.map((i) => i.recipient.email));
	const lines: string[] = [];
	for (const raw of only) {
		const email = normalizeEmail(raw);
		if (queued.has(email)) continue;
		const item = plan.items.find((i) => i.recipient.email === email);
		if (item) {
			lines.push(`  ${STATUS_GLYPH[item.status]} ${raw}: ${item.status} — skipped`);
		}
	}
	return lines;
}

async function handleSend(parsed: ParsedArgs, io: ResolvedIo): Promise<number> {
	const loaded = await loadAll(parsed, io);
	const { dir, env, settings, campaign, plan } = loaded;
	const json = parsed.json === true;
	const dryRun = parsed["dry-run"] === true;
	const only = collectAddresses(parsed.only);
	const limit = intFlag(parsed.limit, "--limit");

	const queue = selectQueue(plan, { only, limit });

	// Everything that can be wrong with the config fails here, before the prompt.
	let smtp: NodemailerTransportOptions | undefined;
	if (!dryRun) smtp = resolveSmtpOptions(env);
	if (!settings.from && queue.length > 0) {
		throw new ConfigError(
			"sender is required: set SMTP_FROM in .env or the environment",
		);
	}

	const intro = [
		`Campaign: ${dir}`,
		`Recipients: ${plan.items.length} — ${formatCounts(plan) || "none"}`,
		...formatSkipped(plan),
		...explainOnlySkips(plan, only, queue),
	];
	if (!json) io.out(intro.join("\n"));

	if (queue.length === 0) {
		if (json) {
			io.out(
				JSON.stringify({
					ok: true,
					dir,
					dryRun,
					sent: 0,
					errors: 0,
					total: 0,
					results: [],
				}),
			);
		} else {
			io.out("Nothing to send.");
		}
		return 0;
	}

	const via = dryRun ? "the mock transport (dry run)" : `${smtp!.host}:${smtp!.port}`;
	const what = `${plural(queue.length, "email")} as "${settings.from}" via ${via}`;
	if (!dryRun && parsed.yes !== true) {
		if (!io.isInteractive()) {
			throw new UsageError(
				"refusing to send without confirmation: pass --yes (-y) when not running in a terminal",
			);
		}
		if (!io.confirm(`Send ${what}?`)) {
			io.out("Aborted, nothing sent.");
			return 0;
		}
	} else if (!json) {
		io.out(
			`Sending ${what}${dryRun ? "" : ` (delay ${settings.delayMs} ms ± 20 %)`}…`,
		);
	}

	const transport = dryRun ? createMockTransport() : io.createTransport(smtp!);

	// Status line + per-recipient transcript above it.
	const line = io.statusLine({
		counters: [{ key: "sent", glyph: "✓" }, { key: "errors", glyph: "✗" }],
		...(json ? { enabled: false, fallback: "silent" as const } : {}),
	});
	const log = (s: string) => {
		if (!json) line.log(s);
	};
	const results: Array<
		{ email: string; status: "sent" | "error"; id?: string; error?: string }
	> = [];
	const tag = dryRun ? "[dry-run] " : "";
	const addressOf = (index: number) => queue[index - 1]?.recipient.address ?? "";

	const onEvent = (e: RunEvent) => {
		switch (e.type) {
			case "verifying":
				line.set("verifying SMTP", smtp?.host ?? "");
				break;
			case "start":
				break;
			case "sending":
				line.set(
					`${e.index}/${e.total} ${addressOf(e.index)}`,
					`sending${e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}…`,
				);
				break;
			case "sent":
				line.inc("sent");
				results.push({ email: e.email, status: "sent", id: e.id });
				log(`${tag}✓ ${e.index}/${e.total} ${addressOf(e.index)}  ${e.subject}${
					e.id ? `  (${e.id})` : ""
				}`);
				break;
			case "error":
				line.inc("errors");
				results.push({ email: e.email, status: "error", error: e.error });
				log(
					`${tag}✗ ${e.index}/${e.total} ${
						addressOf(e.index)
					}  attempt ${e.attempt}${e.gaveUp ? " (gave up)" : ""}: ${e.error}`,
				);
				break;
			case "waiting": {
				const next = queue[e.index]?.recipient.address ?? "";
				line.set(`next: ${next}`, `waiting ${Math.round(e.ms / 1000)} s`);
				break;
			}
			case "aborted":
				log(`interrupted — stopped before ${e.index + 1}/${e.total}`);
				break;
			case "done":
				break;
		}
	};

	// Ctrl-C: first press stops after the in-flight send; second press quits now.
	const controller = new AbortController();
	let interrupts = 0;
	const unsubscribe = io.onInterrupt(() => {
		interrupts++;
		if (interrupts === 1) {
			controller.abort();
			log("Ctrl-C: finishing the current send, then stopping (press again to quit now)");
		} else {
			line.stop({ text: "quit" });
			io.exit(130);
		}
	});

	let summary: RunSummary;
	try {
		summary = await runPlan(plan, campaign.templates, {
			transport,
			settings,
			appendLedger: createLedgerAppender(dir),
			limit,
			only,
			dryRun,
			verify: parsed.verify !== false,
			signal: controller.signal,
			onEvent,
			...(io.sleep ? { sleep: io.sleep } : {}),
		});
	} catch (e) {
		line.stop();
		throw e;
	} finally {
		unsubscribe();
	}

	const finalText = `${tag}done: ${summary.sent} sent, ${summary.errors} failed` +
		`${summary.aborted ? ", interrupted" : ""}` +
		`${
			summary.sent + summary.errors < summary.total
				? ` (${summary.total - summary.sent - summary.errors} not attempted)`
				: ""
		}`;
	line.stop(json ? undefined : { text: finalText });

	if (json) {
		io.out(JSON.stringify({ ok: summary.errors === 0, dir, ...summary, results }));
	}
	return summary.errors > 0 ? 1 : 0;
}

/**
 * Runs the CLI and returns a process exit code. Never calls `Deno.exit`
 * (except through the injectable `exit` on a second Ctrl-C).
 *
 * @param args - Argument vector (e.g. `Deno.args`).
 * @param io - Optional injected collaborators (see {@link CliIo}).
 * @returns `0` success, `1` runtime failure (including any failed send), `2` usage/config error.
 */
export async function runCli(args: string[], io: CliIo = {}): Promise<number> {
	const resolved = resolveIo(io);
	const parsed = parseArgs(args, {
		string: ["env-file", "limit", "delay", "max-attempts", "to"],
		boolean: ["dry-run", "yes", "json", "help", "version", "verify"],
		negatable: ["verify"],
		collect: ["only"],
		alias: { h: "help", y: "yes" },
		default: { verify: true },
	});

	const command = parsed._[0] !== undefined ? String(parsed._[0]) : undefined;

	if (parsed.version === true || command === "version") {
		resolved.out(VERSION);
		return 0;
	}
	if (command === "help" || parsed.help === true || !command) {
		if (!command && !parsed.help && args.length > 0) {
			resolved.err(
				"Error: a command is required: send | preview | status | verify. Run with --help for usage.",
			);
			return 2;
		}
		resolved.out(HELP);
		return 0;
	}

	try {
		switch (command) {
			case "send":
				return await handleSend(parsed, resolved);
			case "preview":
				return await handlePreview(parsed, resolved);
			case "status":
				return await handleStatus(parsed, resolved);
			case "verify":
				return await handleVerify(parsed, resolved);
			default:
				throw new UsageError(
					`unknown command "${command}". Valid: send, preview, status, verify, help, version.`,
				);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (parsed.json === true) {
			resolved.err(JSON.stringify({ ok: false, error: message }));
		} else {
			resolved.err(`Error: ${message}`);
		}
		const usage = e instanceof UsageError || e instanceof ConfigError ||
			e instanceof SmtpEnvError;
		return usage ? 2 : 1;
	}
}
