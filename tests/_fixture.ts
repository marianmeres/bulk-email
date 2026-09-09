/** Shared test helper: builds a throwaway campaign directory. */
import { join } from "@std/path";

export interface FixtureFiles {
	subject?: string;
	body?: string;
	html?: string;
	recipients?: string;
	env?: string;
	ledger?: string;
}

export const DEFAULT_FILES: Required<Omit<FixtureFiles, "html" | "env" | "ledger">> = {
	subject: "Hello ${NAME}",
	body: "Dear ${NAME},\n\nthis is for ${EMAIL}.\n",
	recipients: "EMAIL,NAME\na@x.com,Alice\nb@x.com,Bob\nc@x.com,Carol\n",
};

/** Creates a temp campaign dir; returns its path and a cleanup function. */
export async function makeCampaignDir(
	files: FixtureFiles = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await Deno.makeTempDir({ prefix: "bulk-email-test-" });
	const merged = { ...DEFAULT_FILES, ...files };
	await Deno.writeTextFile(join(dir, "subject.txt"), merged.subject);
	await Deno.writeTextFile(join(dir, "body.txt"), merged.body);
	await Deno.writeTextFile(join(dir, "recipients.csv"), merged.recipients);
	if (files.html !== undefined) {
		await Deno.writeTextFile(join(dir, "body.html"), files.html);
	}
	if (files.env !== undefined) await Deno.writeTextFile(join(dir, ".env"), files.env);
	if (files.ledger !== undefined) {
		await Deno.writeTextFile(join(dir, "log.jsonl"), files.ledger);
	}
	return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

export async function readLedgerFile(dir: string): Promise<string> {
	try {
		return await Deno.readTextFile(join(dir, "log.jsonl"));
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return "";
		throw e;
	}
}
