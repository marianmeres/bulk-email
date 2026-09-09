/**
 * The serial send loop.
 *
 * Order of operations per recipient — this is what makes re-runs safe:
 *
 * 1. append `sending` to the ledger
 * 2. `transport.send()`
 * 3. append `sent` (or `error`) to the ledger
 * 4. wait `delayMs` ± 20 % jitter (unless this was the last one)
 *
 * If the process dies between 1 and 3 the recipient shows up as `unknown` on
 * the next run and is never retried automatically. Everything that can be
 * validated up front (sender, template rendering for every queued recipient,
 * the SMTP handshake) happens *before* the first ledger write, so a
 * misconfiguration costs nothing.
 *
 * @module
 */

import { normalizeEmail } from "./recipients.ts";
import { renderEmail } from "./template.ts";
import {
	type CampaignTemplates,
	ConfigError,
	type LedgerEntry,
	type Plan,
	type PlanItem,
	type RenderedEmail,
	type RunEvent,
	type RunOptions,
	type RunSummary,
} from "./types.ts";

/** Default sleep: `setTimeout`, cut short by the abort signal. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			signal?.removeEventListener("abort", done);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** Applies ±20 % jitter to a base delay. */
export function jitter(baseMs: number, random: () => number = Math.random): number {
	if (baseMs <= 0) return 0;
	return Math.round(baseMs * (0.8 + random() * 0.4));
}

/**
 * Narrows the plan's queue to what this run should send.
 *
 * @throws {ConfigError} when an `only` address is not a recipient of the campaign.
 */
export function selectQueue(
	plan: Plan,
	options: { only?: string[]; limit?: number },
): PlanItem[] {
	let queue = plan.queue;
	if (options.only && options.only.length > 0) {
		const wanted = new Set(options.only.map(normalizeEmail));
		const all = new Set(plan.items.map((i) => i.recipient.email));
		const unknown = [...wanted].filter((e) => !all.has(e));
		if (unknown.length > 0) {
			throw new ConfigError(
				`--only: not in recipients.csv: ${unknown.join(", ")}`,
			);
		}
		queue = queue.filter((i) => wanted.has(i.recipient.email));
	}
	if (options.limit !== undefined) {
		if (!Number.isInteger(options.limit) || options.limit < 0) {
			throw new ConfigError(
				`--limit must be a non-negative integer, got ${options.limit}`,
			);
		}
		queue = queue.slice(0, options.limit);
	}
	return queue;
}

/**
 * Sends the plan's queue, serially, writing the ledger as it goes.
 *
 * @param plan - From `planCampaign()`.
 * @param templates - The campaign templates.
 * @param options - Transport, settings, ledger appender, filters, hooks.
 * @returns The run summary (also delivered via the `done` event).
 * @throws {ConfigError} before anything is sent when the sender is missing, a
 * queued message fails to render, or `only` names an unknown recipient.
 * @throws whatever `transport.verify()` throws, before anything is sent.
 */
export async function runPlan(
	plan: Plan,
	templates: CampaignTemplates,
	options: RunOptions,
): Promise<RunSummary> {
	const {
		transport,
		settings,
		appendLedger,
		dryRun = false,
		verify = true,
		signal,
		sleep = defaultSleep,
		now = () => new Date(),
		random = Math.random,
	} = options;
	const emit = (event: RunEvent) => options.onEvent?.(event);

	const queue = selectQueue(plan, { only: options.only, limit: options.limit });
	const total = queue.length;
	const summary: RunSummary = { sent: 0, errors: 0, total, aborted: false, dryRun };

	// Fail fast: render everything before touching the network or the ledger.
	const rendered: RenderedEmail[] = queue.map((item) =>
		renderEmail(templates, item.recipient, settings)
	);

	if (total > 0 && verify && !dryRun && typeof transport.verify === "function") {
		emit({ type: "verifying" });
		await transport.verify();
	}

	emit({ type: "start", total });

	for (let i = 0; i < total; i++) {
		if (signal?.aborted) {
			summary.aborted = true;
			emit({ type: "aborted", index: i, total });
			break;
		}
		const item = queue[i];
		const message = rendered[i];
		const email = item.recipient.email;
		const attempt = item.attempts + 1;
		const index = i + 1;

		emit({ type: "sending", email, index, total, attempt });
		if (!dryRun) {
			await appendLedger({
				ts: now().toISOString(),
				email,
				status: "sending",
				attempt,
			});
		}

		let entry: LedgerEntry;
		try {
			const result = await transport.send({
				to: message.to,
				from: message.from,
				subject: message.subject,
				text: message.text,
				...(message.html !== undefined ? { html: message.html } : {}),
				...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
				...(message.bcc !== undefined ? { bcc: message.bcc } : {}),
			});
			entry = {
				ts: now().toISOString(),
				email,
				status: "sent",
				attempt,
				subject: message.subject,
				id: result.externalId,
			};
		} catch (e) {
			entry = {
				ts: now().toISOString(),
				email,
				status: "error",
				attempt,
				error: e instanceof Error ? e.message : String(e),
			};
		}
		if (!dryRun) await appendLedger(entry);

		if (entry.status === "sent") {
			summary.sent++;
			emit({
				type: "sent",
				email,
				index,
				total,
				id: entry.id ?? "",
				subject: entry.subject ?? "",
			});
		} else {
			summary.errors++;
			emit({
				type: "error",
				email,
				index,
				total,
				attempt,
				error: entry.error ?? "",
				gaveUp: attempt >= settings.maxAttempts,
			});
		}

		const isLast = i === total - 1;
		if (!isLast && !dryRun && !signal?.aborted) {
			const ms = jitter(settings.delayMs, random);
			if (ms > 0) {
				emit({ type: "waiting", ms, index, total });
				await sleep(ms, signal);
			}
		}
	}

	emit({ type: "done", summary });
	return summary;
}
