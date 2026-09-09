/**
 * Template variables and rendering.
 *
 * Templates use `@marianmeres/interpolate` syntax (`$NAME`, `${NAME}`,
 * `${NAME:-default}`, …). Since `interpolate()` renders an unset or empty
 * variable as an empty string, this module adds the **strictness** layer the
 * tool relies on: a variable referenced without a fallback operator is
 * *strict* — it must exist as a CSV column, and must be non-empty for every
 * row that is sent.
 *
 * @module
 */

import { interpolate } from "@marianmeres/interpolate";
import {
	type CampaignSettings,
	type CampaignTemplates,
	ConfigError,
	type Recipient,
	type RenderedEmail,
} from "./types.ts";

/** A variable reference found in a template. */
export interface TemplateVariable {
	/** Variable name as it must appear in the CSV header. */
	name: string;
	/**
	 * `true` when the reference has no fallback (`$NAME`, `${NAME}`,
	 * `${NAME:?msg}`) and therefore requires a non-empty value; `false` for
	 * `${NAME:-x}`, `${NAME-x}`, `${NAME:+x}`, `${NAME+x}`.
	 */
	strict: boolean;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Two-character operators must be tried before their one-character prefixes.
const OPERATOR_RE = /^([A-Za-z_][A-Za-z0-9_]*)(:-|:\+|:\?|:!|-|\+|\?|!)/;
const FALLBACK_OPERATORS = new Set([":-", "-", ":+", "+"]);

/**
 * Lists the variables referenced by a template.
 *
 * @param template - Raw template text.
 * @param columns - Known context keys. A braced expression that is *exactly* a
 * known key (e.g. `${my-var}`) resolves to that key, mirroring interpolate's
 * "literal key wins over operator parsing" rule.
 * @returns Variables in order of first appearance; each name listed once, and
 * a name is strict if *any* of its references is strict.
 */
export function extractTemplateVariables(
	template: string,
	columns: readonly string[] = [],
): TemplateVariable[] {
	const found = new Map<string, boolean>();
	const add = (name: string, strict: boolean) => {
		found.set(name, (found.get(name) ?? false) || strict);
	};
	const known = new Set(columns);

	let i = 0;
	while (i < template.length) {
		const ch = template[i];
		if (ch !== "$") {
			i++;
			continue;
		}
		const next = template[i + 1];
		if (next === "$") {
			i += 2; // `$$` escape
			continue;
		}
		if (next === "{") {
			const close = template.indexOf("}", i + 2);
			if (close < 0) break;
			const inner = template.slice(i + 2, close);
			i = close + 1;
			if (known.has(inner)) {
				add(inner, true);
				continue;
			}
			if (NAME_RE.test(inner)) {
				add(inner, true);
				continue;
			}
			const m = OPERATOR_RE.exec(inner);
			if (m) add(m[1], !FALLBACK_OPERATORS.has(m[2]));
			continue;
		}
		// Unbraced: uppercase names only (interpolate's rule).
		const m = /^[A-Z_][A-Z0-9_]*/.exec(template.slice(i + 1));
		if (m) {
			add(m[0], true);
			i += 1 + m[0].length;
			continue;
		}
		i++;
	}

	return [...found.entries()].map(([name, strict]) => ({ name, strict }));
}

/** Every variable across subject, text and html, merged by name. */
export function extractCampaignVariables(
	templates: CampaignTemplates,
	columns: readonly string[] = [],
): TemplateVariable[] {
	const merged = new Map<string, boolean>();
	for (const tpl of [templates.subject, templates.text, templates.html ?? ""]) {
		for (const v of extractTemplateVariables(tpl, columns)) {
			merged.set(v.name, (merged.get(v.name) ?? false) || v.strict);
		}
	}
	return [...merged.entries()].map(([name, strict]) => ({ name, strict }));
}

/**
 * Campaign-level check: every strict variable must be a CSV column.
 *
 * @throws {ConfigError} naming the missing columns.
 */
export function assertStrictVariablesHaveColumns(
	templates: CampaignTemplates,
	columns: readonly string[],
): void {
	const known = new Set(columns);
	const missing = extractCampaignVariables(templates, columns)
		.filter((v) => v.strict && !known.has(v.name))
		.map((v) => v.name);
	if (missing.length > 0) {
		throw new ConfigError(
			`template references ${missing.length === 1 ? "a variable" : "variables"} ` +
				`with no matching recipients.csv column: ${missing.join(", ")} ` +
				`(add the column, or use \${${
					missing[0]
				}:-fallback} to make it optional)`,
		);
	}
}

/**
 * Row-level check: which strict variables are empty for this recipient.
 *
 * @returns Variable names with a missing or blank value, in template order.
 */
export function findEmptyStrictVariables(
	templates: CampaignTemplates,
	recipient: Recipient,
	columns: readonly string[],
): string[] {
	return extractCampaignVariables(templates, columns)
		.filter((v) => v.strict)
		.filter((v) => (recipient.context[v.name] ?? "").trim() === "")
		.map((v) => v.name);
}

/** Collapses a rendered subject to a single line. */
function singleLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Renders the message for one recipient.
 *
 * @throws {ConfigError} when `settings.from` is missing, or when interpolate
 * itself throws (a `${VAR:?message}` assertion).
 */
export function renderEmail(
	templates: CampaignTemplates,
	recipient: Recipient,
	settings: CampaignSettings,
): RenderedEmail {
	if (!settings.from || settings.from.trim() === "") {
		throw new ConfigError(
			"sender is required: set SMTP_FROM in .env or the environment",
		);
	}
	let subject: string;
	let text: string;
	let html: string | undefined;
	try {
		subject = singleLine(interpolate(templates.subject, recipient.context));
		text = interpolate(templates.text, recipient.context);
		html = templates.html === undefined
			? undefined
			: interpolate(templates.html, recipient.context);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new ConfigError(`row ${recipient.row} (${recipient.email}): ${msg}`);
	}

	const rendered: RenderedEmail = {
		to: recipient.address,
		from: settings.from,
		subject,
		text,
	};
	if (html !== undefined) rendered.html = html;
	if (settings.replyTo) rendered.replyTo = settings.replyTo;
	if (settings.bcc) rendered.bcc = settings.bcc;
	return rendered;
}
