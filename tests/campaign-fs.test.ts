import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
	assertCampaignDir,
	CAMPAIGN_FILES,
	createLedgerAppender,
	loadCampaign,
	loadCampaignEnv,
	loadLedger,
} from "../src/campaign-fs.ts";
import { ConfigError } from "../src/types.ts";
import { makeCampaignDir, readLedgerFile } from "./_fixture.ts";

Deno.test("assertCampaignDir: missing / not a directory → ConfigError", async () => {
	await assertRejects(
		() => assertCampaignDir("/definitely/not/here"),
		ConfigError,
		"not found",
	);
	const { dir, cleanup } = await makeCampaignDir();
	try {
		await assertRejects(
			() => assertCampaignDir(join(dir, CAMPAIGN_FILES.subject)),
			ConfigError,
			"not a directory",
		);
		assertEquals(await assertCampaignDir(dir), dir);
	} finally {
		await cleanup();
	}
});

Deno.test("loadCampaign: reads templates + recipients; html optional; subject trimmed", async () => {
	const { dir, cleanup } = await makeCampaignDir({ subject: "  Hi ${NAME} \n" });
	try {
		const c = await loadCampaign(dir);
		assertEquals(c.templates.subject, "Hi ${NAME}");
		assertEquals(c.templates.html, undefined);
		assertEquals(c.recipients.length, 3);
		assertEquals(c.columns, ["EMAIL", "NAME"]);
		await Deno.writeTextFile(join(dir, CAMPAIGN_FILES.html), "<p>${NAME}</p>");
		assertEquals((await loadCampaign(dir)).templates.html, "<p>${NAME}</p>");
	} finally {
		await cleanup();
	}
});

Deno.test("loadCampaign: missing / blank required files → ConfigError", async () => {
	const { dir, cleanup } = await makeCampaignDir({ body: "   \n" });
	try {
		await assertRejects(() => loadCampaign(dir), ConfigError, "body.txt is empty");
		await Deno.remove(join(dir, CAMPAIGN_FILES.recipients));
		await assertRejects(
			() => loadCampaign(dir),
			ConfigError,
			"missing recipients.csv",
		);
	} finally {
		await cleanup();
	}
});

Deno.test("loadLedger + createLedgerAppender: absent → empty; appends round-trip", async () => {
	const { dir, cleanup } = await makeCampaignDir();
	try {
		assertEquals((await loadLedger(dir)).entries, []);
		const append = createLedgerAppender(dir);
		await append({ ts: "t1", email: "a@x.com", status: "sending", attempt: 1 });
		await append({
			ts: "t2",
			email: "a@x.com",
			status: "sent",
			attempt: 1,
			id: "<1>",
		});
		const text = await readLedgerFile(dir);
		assertEquals(text.split("\n").length, 3); // two lines + trailing newline
		const state = await loadLedger(dir);
		assertEquals(state.entries.length, 2);
		assertEquals(state.records.get("a@x.com")?.sent?.id, "<1>");
	} finally {
		await cleanup();
	}
});

Deno.test("loadLedger: corrupt ledger → ConfigError", async () => {
	const { dir, cleanup } = await makeCampaignDir({ ledger: "{oops\n" });
	try {
		await assertRejects(() => loadLedger(dir), ConfigError, "line 1");
	} finally {
		await cleanup();
	}
});

Deno.test("loadCampaignEnv: <dir>/.env optional; process env wins unless blank", async () => {
	const { dir, cleanup } = await makeCampaignDir({
		env: "SMTP_HOST=file.host\nSMTP_FROM=file@x.com\nDELAY_MS=5\n",
	});
	try {
		const env = await loadCampaignEnv(dir, {
			processEnv: (k) =>
				({ SMTP_HOST: "proc.host", SMTP_FROM: "  " } as Record<string, string>)[
					k
				],
		});
		assertEquals(env("SMTP_HOST"), "proc.host");
		assertEquals(env("SMTP_FROM"), "file@x.com");
		assertEquals(env("DELAY_MS"), "5");
		assertEquals(env("NOPE"), undefined);
	} finally {
		await cleanup();
	}
});

Deno.test("loadCampaignEnv: no .env at all is fine; explicit --env-file must exist and replaces <dir>/.env", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: "SMTP_HOST=dir.host\n" });
	const { dir: bare, cleanup: cleanupBare } = await makeCampaignDir();
	try {
		const none = await loadCampaignEnv(bare, { processEnv: () => undefined });
		assertEquals(none("SMTP_HOST"), undefined);

		await assertRejects(
			() =>
				loadCampaignEnv(dir, {
					envFile: join(dir, "missing.env"),
					processEnv: () => undefined,
				}),
			ConfigError,
			"env file not found",
		);

		const shared = join(bare, "shared.env");
		await Deno.writeTextFile(shared, "SMTP_HOST=shared.host\n");
		const env = await loadCampaignEnv(dir, {
			envFile: shared,
			processEnv: () => undefined,
		});
		assertEquals(env("SMTP_HOST"), "shared.host"); // not dir.host
	} finally {
		await cleanup();
		await cleanupBare();
	}
});
