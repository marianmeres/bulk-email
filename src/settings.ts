/**
 * Campaign settings from env-shaped values.
 *
 * Pure, like `resolveSmtpOptions()` in `@marianmeres/send-email`: the caller
 * supplies the `key → value` lookup; nothing ambient is read here.
 *
 * | Key                 | Maps to                        | Default  |
 * | ------------------- | ------------------------------ | -------- |
 * | `SMTP_FROM`         | `from` (required to send)      | —        |
 * | `SMTP_REPLY_TO`     | `replyTo`                      | —        |
 * | `BCC`               | `bcc`                          | —        |
 * | `DELAY_MS`          | `delayMs` (integer ≥ 0)        | `10000`  |
 * | `MAX_ATTEMPTS`      | `maxAttempts` (integer ≥ 1)    | `3`      |
 * | `PREVENT_THREADING` | `preventThreading` (boolean)   | `true`   |
 *
 * @module
 */

import { parseBoolean } from "@marianmeres/parse-boolean";
import type { EnvGetter } from "@marianmeres/send-email";
import { type CampaignSettings, ConfigError, DEFAULT_SETTINGS } from "./types.ts";

/** Strict non-negative decimal integer, or `undefined` for blank/unset. */
function parseIntValue(
	value: string | number | undefined,
	name: string,
	min: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < min) {
			throw new ConfigError(`${name} must be an integer >= ${min}, got ${value}`);
		}
		return value;
	}
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	if (!/^\d+$/.test(trimmed)) {
		throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
	}
	const n = Number(trimmed);
	if (n < min) throw new ConfigError(`${name} must be >= ${min}, got ${n}`);
	return n;
}

/** Non-blank string or `undefined`. */
function nonBlank(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const t = value.trim();
	return t === "" ? undefined : t;
}

/**
 * Boolean via `parseBoolean` in strict mode (`true`/`yes`/`on`/`1`,
 * `false`/`no`/`off`/`0`, …), or `undefined` for blank/unset.
 */
function parseBoolValue(
	value: string | boolean | undefined,
	name: string,
): boolean | undefined {
	if (value === undefined || (typeof value === "string" && value.trim() === "")) {
		return undefined;
	}
	try {
		return parseBoolean(value, { strict: true });
	} catch {
		throw new ConfigError(`${name} must be true or false, got "${value}"`);
	}
}

/**
 * Overrides applied on top of env values (typically CLI flags). String
 * values are parsed exactly like env values.
 */
export interface SettingsOverrides {
	/** Sender. */
	from?: string;
	/** Reply-To. */
	replyTo?: string;
	/** BCC on every message. */
	bcc?: string;
	/** Unique threading headers per send; a string is parsed like `PREVENT_THREADING`. */
	preventThreading?: boolean | string;
	/** Base delay in ms (integer ≥ 0); a string is parsed like `DELAY_MS`. */
	delayMs?: number | string;
	/** Attempt limit (integer ≥ 1); a string is parsed like `MAX_ATTEMPTS`. */
	maxAttempts?: number | string;
}

/**
 * Resolves {@link CampaignSettings} from an env lookup plus optional overrides.
 *
 * @param env - `key → value` lookup (e.g. process env merged with `.env`).
 * @param overrides - Values that win over env (CLI flags).
 * @throws {ConfigError} on a malformed `DELAY_MS` / `MAX_ATTEMPTS` /
 * `PREVENT_THREADING`.
 */
export function resolveCampaignSettings(
	env: EnvGetter,
	overrides: SettingsOverrides = {},
): CampaignSettings {
	const settings: CampaignSettings = {
		delayMs: parseIntValue(overrides.delayMs, "--delay", 0) ??
			parseIntValue(env("DELAY_MS"), "DELAY_MS", 0) ??
			DEFAULT_SETTINGS.delayMs,
		maxAttempts: parseIntValue(overrides.maxAttempts, "--max-attempts", 1) ??
			parseIntValue(env("MAX_ATTEMPTS"), "MAX_ATTEMPTS", 1) ??
			DEFAULT_SETTINGS.maxAttempts,
	};
	const from = nonBlank(overrides.from) ?? nonBlank(env("SMTP_FROM"));
	if (from !== undefined) settings.from = from;
	const replyTo = nonBlank(overrides.replyTo) ?? nonBlank(env("SMTP_REPLY_TO"));
	if (replyTo !== undefined) settings.replyTo = replyTo;
	const bcc = nonBlank(overrides.bcc) ?? nonBlank(env("BCC"));
	if (bcc !== undefined) settings.bcc = bcc;
	settings.preventThreading =
		parseBoolValue(overrides.preventThreading, "preventThreading") ??
			parseBoolValue(env("PREVENT_THREADING"), "PREVENT_THREADING") ??
			DEFAULT_SETTINGS.preventThreading;
	return settings;
}
