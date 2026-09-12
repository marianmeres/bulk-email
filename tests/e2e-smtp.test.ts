/**
 * End-to-end: the real CLI, the real nodemailer transport from
 * `@marianmeres/send-email`, a fake local SMTP server. No network beyond
 * localhost, no credentials.
 */
import {
	assertEquals,
	assertMatch,
	assertNotEquals,
	assertStringIncludes,
} from "@std/assert";
import { runCli } from "../src/cli.ts";
import { startFakeSmtp } from "./_fake-smtp.ts";
import { makeCampaignDir, readLedgerFile } from "./_fixture.ts";

Deno.test({
	name:
		"e2e: send through a real SMTP transport, ledger written, re-run idempotent, failure retried",
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const smtp = startFakeSmtp();
		const { dir, cleanup } = await makeCampaignDir({
			env: [
				"SMTP_HOST=127.0.0.1",
				`SMTP_PORT=${smtp.port}`,
				"SMTP_SECURE=false",
				"SMTP_FROM=Bulk Test <bulk@test.local>",
				"SMTP_REPLY_TO=reply@test.local",
				"BCC=copy@test.local",
				"DELAY_MS=0",
				"MAX_ATTEMPTS=2",
				"PREVENT_THREADING=false",
				"",
			].join("\n"),
			recipients: "EMAIL,NAME\nalice@test.local,Alice\nbob@test.local,Bob\n",
			html: "<p>Hi <b>${NAME}</b></p>",
		});
		const out: string[] = [];
		const err: string[] = [];
		const io = {
			out: (l: string) => void out.push(l),
			err: (l: string) => void err.push(l),
			env: () => undefined,
			onInterrupt: () => () => {},
		};
		try {
			// First run: bob fails once (451), alice goes through.
			let bobRejections = 0;
			smtp.failIf = ({ to }) => {
				if (to.some((t) => t.includes("bob@")) && bobRejections === 0) {
					bobRejections++;
					return true;
				}
				return false;
			};
			assertEquals(await runCli(["send", dir, "-y"], io), 1, err.join("\n"));

			assertEquals(smtp.messages.length, 1);
			const m = smtp.messages[0];
			assertEquals(m.from, "<bulk@test.local>");
			assertEquals(m.to, ["<alice@test.local>", "<copy@test.local>"]);
			assertStringIncludes(m.data, "Subject: Hello Alice");
			assertStringIncludes(m.data, "Reply-To: reply@test.local");
			assertStringIncludes(m.data, "Dear Alice,");
			assertStringIncludes(m.data, "<p>Hi <b>Alice</b></p>");
			assertEquals(m.data.includes("Bcc:"), false); // BCC must not leak into headers
			// PREVENT_THREADING=false: no threading headers.
			assertEquals(/^(References|X-Entity-Ref-ID):/im.test(m.data), false);

			let ledger = (await readLedgerFile(dir)).trim().split("\n").map((l) =>
				JSON.parse(l)
			);
			assertEquals(ledger.map((e) => [e.email, e.status, e.attempt]), [
				["alice@test.local", "sending", 1],
				["alice@test.local", "sent", 1],
				["bob@test.local", "sending", 1],
				["bob@test.local", "error", 1],
			]);
			assertStringIncludes(ledger[3].error, "451");
			assertEquals(typeof ledger[1].id, "string");

			// Second run: only bob is retried, alice untouched.
			out.length = 0;
			assertEquals(await runCli(["send", dir, "-y"], io), 0, err.join("\n"));
			assertStringIncludes(out.join("\n"), "1 sent, 1 retry");
			assertEquals(smtp.messages.length, 2);
			assertEquals(smtp.messages[1].to, ["<bob@test.local>", "<copy@test.local>"]);
			ledger = (await readLedgerFile(dir)).trim().split("\n").map((l) =>
				JSON.parse(l)
			);
			assertEquals(ledger.length, 6);
			assertEquals(ledger[5], {
				...ledger[5],
				email: "bob@test.local",
				status: "sent",
				attempt: 2,
				subject: "Hello Bob",
			});

			// Third run: nothing to do, no connection made.
			out.length = 0;
			assertEquals(await runCli(["send", dir, "-y"], io), 0);
			assertEquals(out.at(-1), "Nothing to send.");
			assertEquals(smtp.messages.length, 2);

			// verify works against the real server too.
			out.length = 0;
			assertEquals(await runCli(["verify", dir], io), 0);
			assertStringIncludes(out[0], "connection + auth OK");
		} finally {
			await cleanup();
			await smtp.close();
		}
	},
});

Deno.test({
	name: "e2e: PREVENT_THREADING puts a fresh References + X-Entity-Ref-ID on the wire",
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const smtp = startFakeSmtp();
		const { dir, cleanup } = await makeCampaignDir({
			env: [
				"SMTP_HOST=127.0.0.1",
				`SMTP_PORT=${smtp.port}`,
				"SMTP_SECURE=false",
				"SMTP_FROM=Bulk Test <bulk@test.local>",
				"DELAY_MS=0",
				"PREVENT_THREADING=true",
				"",
			].join("\n"),
			subject: "The same subject for everyone",
			recipients: "EMAIL,NAME\nalice@test.local,Alice\nbob@test.local,Bob\n",
		});
		const err: string[] = [];
		const io = {
			out: () => {},
			err: (l: string) => void err.push(l),
			env: () => undefined,
			onInterrupt: () => () => {},
		};
		try {
			assertEquals(await runCli(["send", dir, "-y"], io), 0, err.join("\n"));
			assertEquals(smtp.messages.length, 2);
			const ids = smtp.messages.map((m) => {
				// Header names are case-insensitive; nodemailer may normalize their case.
				const id = /^X-Entity-Ref-ID: ([0-9a-f-]{36})$/im.exec(m.data)?.[1];
				assertEquals(typeof id, "string", m.data);
				assertMatch(
					m.data,
					new RegExp(`^References: <${id}@test\\.local>$`, "im"),
				);
				return id;
			});
			assertNotEquals(ids[0], ids[1]);
		} finally {
			await cleanup();
			await smtp.close();
		}
	},
});
