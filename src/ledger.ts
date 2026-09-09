/**
 * The JSONL ledger (`log.jsonl`) — the idempotency record.
 *
 * One JSON object per line, append-only. Parsing is strict: a malformed line
 * is a {@link ConfigError}, because guessing at a corrupt ledger is how a
 * message gets sent twice. To force a resend, delete that recipient's lines.
 *
 * @module
 */

import {
	ConfigError,
	type LedgerEntry,
	type LedgerRecord,
	type LedgerState,
} from "./types.ts";

const STATUSES = new Set(["sending", "sent", "error"]);

/** Serializes one entry as a single JSON line (no trailing newline). */
export function serializeLedgerEntry(entry: LedgerEntry): string {
	// Fixed key order → stable, greppable lines.
	const ordered: Record<string, unknown> = {
		ts: entry.ts,
		email: entry.email,
		status: entry.status,
		attempt: entry.attempt,
	};
	if (entry.subject !== undefined) ordered.subject = entry.subject;
	if (entry.id !== undefined) ordered.id = entry.id;
	if (entry.error !== undefined) ordered.error = entry.error;
	return JSON.stringify(ordered);
}

/** Parses one ledger line. Exported for tests; prefer {@link parseLedger}. */
export function parseLedgerLine(line: string, lineNo: number): LedgerEntry {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new ConfigError(`log.jsonl line ${lineNo}: not valid JSON`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ConfigError(`log.jsonl line ${lineNo}: expected a JSON object`);
	}
	const o = raw as Record<string, unknown>;
	if (typeof o.ts !== "string" || o.ts === "") {
		throw new ConfigError(`log.jsonl line ${lineNo}: missing "ts"`);
	}
	if (typeof o.email !== "string" || o.email === "") {
		throw new ConfigError(`log.jsonl line ${lineNo}: missing "email"`);
	}
	if (typeof o.status !== "string" || !STATUSES.has(o.status)) {
		throw new ConfigError(
			`log.jsonl line ${lineNo}: "status" must be one of sending, sent, error`,
		);
	}
	if (typeof o.attempt !== "number" || !Number.isInteger(o.attempt) || o.attempt < 1) {
		throw new ConfigError(
			`log.jsonl line ${lineNo}: "attempt" must be a positive integer`,
		);
	}
	const entry: LedgerEntry = {
		ts: o.ts,
		email: o.email.trim().toLowerCase(),
		status: o.status as LedgerEntry["status"],
		attempt: o.attempt,
	};
	if (typeof o.subject === "string") entry.subject = o.subject;
	if (typeof o.id === "string") entry.id = o.id;
	if (typeof o.error === "string") entry.error = o.error;
	return entry;
}

/**
 * Parses the whole ledger text. Blank lines are ignored.
 *
 * @throws {ConfigError} on the first malformed line.
 */
export function parseLedger(text: string): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		entries.push(parseLedgerLine(line, i + 1));
	}
	return entries;
}

/**
 * Indexes entries by recipient.
 *
 * A `sending` entry is *dangling* unless a later `sent`/`error` for the same
 * recipient follows it. A `sent` entry wins over everything: once a recipient
 * has one, it is done, whatever else the ledger says.
 */
export function buildLedgerState(entries: LedgerEntry[]): LedgerState {
	const records = new Map<string, LedgerRecord>();
	for (const entry of entries) {
		let rec = records.get(entry.email);
		if (!rec) {
			rec = { errors: [] };
			records.set(entry.email, rec);
		}
		switch (entry.status) {
			case "sending":
				rec.dangling = entry;
				break;
			case "sent":
				rec.sent = rec.sent ?? entry;
				rec.dangling = undefined;
				break;
			case "error":
				rec.errors.push(entry);
				rec.dangling = undefined;
				break;
		}
	}
	return { entries, records };
}

/** Convenience: {@link parseLedger} + {@link buildLedgerState}. */
export function loadLedgerState(text: string): LedgerState {
	return buildLedgerState(parseLedger(text));
}
