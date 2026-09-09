/**
 * Deno-only: a campaign as a **directory**.
 *
 * ```
 * my-campaign/
 *   .env              SMTP_* + FROM/REPLY_TO/BCC/DELAY_MS/MAX_ATTEMPTS (optional)
 *   subject.txt       interpolated
 *   body.txt          interpolated, plain text
 *   body.html         optional; interpolated, sent as the HTML alternative
 *   recipients.csv    header row with an EMAIL column; every column is a variable
 *   log.jsonl         written by the tool — the idempotency ledger
 * ```
 *
 * @module
 */

import { parse as parseDotenv } from "@std/dotenv";
import { join, resolve } from "@std/path";
import type { EnvGetter } from "@marianmeres/send-email";
import { loadLedgerState, serializeLedgerEntry } from "./ledger.ts";
import { parseRecipients } from "./recipients.ts";
import {
	type Campaign,
	type CampaignTemplates,
	ConfigError,
	type LedgerEntry,
	type LedgerState,
} from "./types.ts";

/** The fixed file names inside a campaign directory. */
export const CAMPAIGN_FILES: Readonly<{
	subject: string;
	text: string;
	html: string;
	recipients: string;
	ledger: string;
	env: string;
}> = Object.freeze({
	subject: "subject.txt",
	text: "body.txt",
	html: "body.html",
	recipients: "recipients.csv",
	ledger: "log.jsonl",
	env: ".env",
});

/** Reads a required text file, mapping not-found to a {@link ConfigError}. */
async function readRequired(dir: string, name: string): Promise<string> {
	try {
		return await Deno.readTextFile(join(dir, name));
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) {
			throw new ConfigError(`missing ${name} in ${dir}`);
		}
		throw e;
	}
}

/** Reads an optional text file; `undefined` when absent. */
async function readOptional(dir: string, name: string): Promise<string | undefined> {
	try {
		return await Deno.readTextFile(join(dir, name));
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return undefined;
		throw e;
	}
}

/**
 * Asserts `dir` exists and is a directory.
 *
 * @throws {ConfigError} otherwise.
 */
export async function assertCampaignDir(dir: string): Promise<string> {
	const abs = resolve(dir);
	try {
		const info = await Deno.stat(abs);
		if (!info.isDirectory) throw new ConfigError(`not a directory: ${abs}`);
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) {
			throw new ConfigError(`campaign directory not found: ${abs}`);
		}
		throw e;
	}
	return abs;
}

/**
 * Loads the templates and recipients of a campaign directory.
 *
 * @throws {ConfigError} when a required file is missing, the CSV has no
 * `EMAIL` column, or `subject.txt` / `body.txt` is blank.
 */
export async function loadCampaign(dir: string): Promise<Campaign> {
	const abs = await assertCampaignDir(dir);
	const [subject, text, html, csv] = await Promise.all([
		readRequired(abs, CAMPAIGN_FILES.subject),
		readRequired(abs, CAMPAIGN_FILES.text),
		readOptional(abs, CAMPAIGN_FILES.html),
		readRequired(abs, CAMPAIGN_FILES.recipients),
	]);
	if (subject.trim() === "") {
		throw new ConfigError(`${CAMPAIGN_FILES.subject} is empty`);
	}
	if (text.trim() === "") throw new ConfigError(`${CAMPAIGN_FILES.text} is empty`);

	const templates: CampaignTemplates = { subject: subject.trim(), text };
	if (html !== undefined) templates.html = html;

	const parsed = parseRecipients(csv);
	return { templates, ...parsed };
}

/** Reads and parses `log.jsonl`; an absent file is an empty ledger. */
export async function loadLedger(dir: string): Promise<LedgerState> {
	const text = await readOptional(resolve(dir), CAMPAIGN_FILES.ledger);
	return loadLedgerState(text ?? "");
}

/**
 * Returns an appender that writes one JSON line per call to `log.jsonl`,
 * creating the file on first use. Suitable for `RunOptions.appendLedger`.
 */
export function createLedgerAppender(dir: string): (entry: LedgerEntry) => Promise<void> {
	const path = join(resolve(dir), CAMPAIGN_FILES.ledger);
	return async (entry: LedgerEntry): Promise<void> => {
		await Deno.writeTextFile(path, serializeLedgerEntry(entry) + "\n", {
			append: true,
		});
	};
}

/** Options for {@link loadCampaignEnv}. */
export interface LoadCampaignEnvOptions {
	/**
	 * Explicit `.env` path. When given it *replaces* `<dir>/.env` and must
	 * exist. When omitted, `<dir>/.env` is loaded if present.
	 */
	envFile?: string;
	/** Process env lookup. Default: `Deno.env.get`. */
	processEnv?: EnvGetter;
}

/**
 * Builds the env lookup for a campaign: **process env wins** over the `.env`
 * file, except that a present-but-blank process value does not shadow a file
 * value. The file is `<dir>/.env` by default (optional), or `envFile`
 * (required) when given.
 *
 * @throws {ConfigError} when an explicit `envFile` does not exist.
 */
export async function loadCampaignEnv(
	dir: string,
	options: LoadCampaignEnvOptions = {},
): Promise<EnvGetter> {
	const processEnv = options.processEnv ?? ((key: string) => Deno.env.get(key));
	const explicit = options.envFile !== undefined;
	const path = explicit
		? resolve(options.envFile!)
		: join(resolve(dir), CAMPAIGN_FILES.env);

	let fileEnv: Record<string, string> = {};
	try {
		fileEnv = parseDotenv(await Deno.readTextFile(path));
	} catch (e) {
		if (!(e instanceof Deno.errors.NotFound)) throw e;
		if (explicit) throw new ConfigError(`env file not found: ${path}`);
	}

	return (key: string): string | undefined => {
		const fromProcess = processEnv(key);
		if (fromProcess !== undefined && fromProcess.trim() !== "") return fromProcess;
		return fileEnv[key];
	};
}
