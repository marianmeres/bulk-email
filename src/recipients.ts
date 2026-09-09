/**
 * `recipients.csv` → {@link Recipient} list.
 *
 * Rules:
 * - The header row is required and must contain an `EMAIL` column (matched
 *   case-insensitively after trimming; the context key is the header as
 *   written, trimmed).
 * - Every column becomes an interpolation variable; values are trimmed.
 * - Addresses are normalized (trim + lower-case) for identity; the first
 *   occurrence wins, later duplicates are skipped.
 * - Rows whose every cell is blank are skipped silently-but-reported.
 *
 * @module
 */

import { parseCsv } from "@marianmeres/parse-csv";
import {
	ConfigError,
	type Recipient,
	type RecipientsParseResult,
	type SkippedRow,
} from "./types.ts";

/** Normalizes an address for identity comparison: trim + lower-case. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Deliberately loose address check: one `@`, something on both sides, no
 * whitespace. Anything stricter rejects real addresses; the SMTP server is the
 * authority anyway.
 */
export function isPlausibleEmail(email: string): boolean {
	const s = email.trim();
	if (s.length === 0 || /\s/.test(s)) return false;
	const at = s.indexOf("@");
	if (at <= 0 || at !== s.lastIndexOf("@")) return false;
	const domain = s.slice(at + 1);
	return domain.length > 0 && domain.includes(".") && !domain.startsWith(".") &&
		!domain.endsWith(".");
}

/**
 * Parses the CSV text of `recipients.csv`.
 *
 * @param text - Raw CSV (UTF-8; a BOM is tolerated).
 * @returns Unique valid recipients, the column list, and the skipped rows.
 * @throws {ConfigError} when the CSV is empty or has no `EMAIL` column.
 */
export function parseRecipients(text: string): RecipientsParseResult {
	const rows = parseCsv(text);
	// A trailing newline yields a final empty row — drop fully-empty trailing rows.
	while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) {
		rows.pop();
	}
	if (rows.length === 0) {
		throw new ConfigError(
			"recipients.csv is empty (a header row with EMAIL is required)",
		);
	}

	const header = rows[0].map((h) => h.trim());
	const emailIndex = header.findIndex((h) => h.toUpperCase() === "EMAIL");
	if (emailIndex < 0) {
		throw new ConfigError(
			`recipients.csv has no EMAIL column (header: ${
				header.join(", ") || "<empty>"
			})`,
		);
	}
	const duplicateHeader = header.find((h, i) => h !== "" && header.indexOf(h) !== i);
	if (duplicateHeader !== undefined) {
		throw new ConfigError(
			`recipients.csv has a duplicate column: ${duplicateHeader}`,
		);
	}
	const columns = header.filter((h) => h !== "");

	const recipients: Recipient[] = [];
	const skipped: SkippedRow[] = [];
	const seen = new Set<string>();

	for (let i = 1; i < rows.length; i++) {
		const row = i; // 1-based data-row number
		const cells = rows[i];
		if (cells.every((c) => c.trim() === "")) {
			skipped.push({ row, reason: "empty-row" });
			continue;
		}
		const rawEmail = (cells[emailIndex] ?? "").trim();
		if (!isPlausibleEmail(rawEmail)) {
			skipped.push({ row, reason: "invalid-email", email: rawEmail });
			continue;
		}
		const email = normalizeEmail(rawEmail);
		if (seen.has(email)) {
			skipped.push({ row, reason: "duplicate", email: rawEmail });
			continue;
		}
		seen.add(email);

		const context: Record<string, string> = {};
		header.forEach((name, col) => {
			if (name === "") return;
			context[name] = (cells[col] ?? "").trim();
		});
		recipients.push({ email, address: rawEmail, row, context });
	}

	return { recipients, columns, skipped };
}
