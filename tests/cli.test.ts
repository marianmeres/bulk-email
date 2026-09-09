import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { StatusLine, StatusLineOptions } from "@marianmeres/cli-status-line";
import {
	createMockTransport,
	type EmailTransport,
	type MockEmailTransport,
	type MockEmailTransportOptions,
	type NodemailerTransportOptions,
} from "@marianmeres/send-email";
import { type CliIo, runCli } from "../src/cli.ts";
import { makeCampaignDir, readLedgerFile } from "./_fixture.ts";

const SMTP_ENV =
	"SMTP_HOST=smtp.test\nSMTP_PORT=2525\nSMTP_FROM=Me <me@x.com>\nDELAY_MS=0\n";

interface Harness {
	io: CliIo;
	out: string[];
	err: string[];
	log: string[];
	sets: string[];
	stopped: string[];
	transports: MockEmailTransport[];
	smtpOptions: NodemailerTransportOptions[];
	confirms: string[];
	interrupt?: () => void;
	exits: number[];
}

function makeIo(
	overrides: Partial<CliIo> & { mock?: MockEmailTransportOptions } = {},
): Harness {
	const h: Harness = {
		out: [],
		err: [],
		log: [],
		sets: [],
		stopped: [],
		transports: [],
		smtpOptions: [],
		confirms: [],
		exits: [],
		io: {},
	};
	const fakeStatusLine = (_o: StatusLineOptions): StatusLine => ({
		set: (label, detail) => void h.sets.push(`${label} | ${detail ?? ""}`),
		inc: () => {},
		log: (...args) => void h.log.push(args.map(String).join(" ")),
		pause: () => {},
		resume: () => {},
		stop: (o) => void h.stopped.push(o?.text ?? ""),
		elapsedMs: 0,
	});
	const { mock, ...rest } = overrides;
	h.io = {
		out: (l) => void h.out.push(l),
		err: (l) => void h.err.push(l),
		env: () => undefined,
		isInteractive: () => false,
		confirm: (q) => {
			h.confirms.push(q);
			return true;
		},
		createTransport: (options): EmailTransport => {
			h.smtpOptions.push(options);
			const t = createMockTransport(mock);
			h.transports.push(t);
			return t;
		},
		statusLine: fakeStatusLine,
		onInterrupt: (handler) => {
			h.interrupt = handler;
			return () => {
				h.interrupt = undefined;
			};
		},
		exit: (code) => void h.exits.push(code),
		sleep: () => Promise.resolve(),
		...rest,
	};
	return h;
}

const allSent = (h: Harness) => h.transports.flatMap((t) => t.sentEmails);

// --- meta ------------------------------------------------------------------

Deno.test("cli: help / version / no command / unknown command", async () => {
	let h = makeIo();
	assertEquals(await runCli([], h.io), 0);
	assertStringIncludes(h.out.join("\n"), "Usage:");
	h = makeIo();
	assertEquals(await runCli(["--help"], h.io), 0);
	assertStringIncludes(h.out.join("\n"), "send <dir>");
	h = makeIo();
	assertEquals(await runCli(["version"], h.io), 0);
	assertEquals(/^\d+\.\d+\.\d+/.test(h.out[0]), true);
	h = makeIo();
	assertEquals(await runCli(["--dry-run"], h.io), 2);
	assertStringIncludes(h.err[0], "a command is required");
	h = makeIo();
	assertEquals(await runCli(["frobnicate", "x"], h.io), 2);
	assertStringIncludes(h.err[0], "unknown command");
});

Deno.test("cli: missing / nonexistent campaign dir → exit 2", async () => {
	let h = makeIo();
	assertEquals(await runCli(["status"], h.io), 2);
	assertStringIncludes(h.err[0], "campaign directory is required");
	h = makeIo();
	assertEquals(await runCli(["status", "/nope/nada"], h.io), 2);
	assertStringIncludes(h.err[0], "not found");
});

// --- status ----------------------------------------------------------------

Deno.test("cli status: text and json", async () => {
	const { dir, cleanup } = await makeCampaignDir({
		recipients:
			"EMAIL,NAME\na@x.com,Alice\nb@x.com,\nA@X.COM,dup\nc@x.com,Carol\nd@x.com,Dan\n",
		ledger: [
			'{"ts":"2026-09-09T10:00:00.000Z","email":"a@x.com","status":"sent","attempt":1,"subject":"Hello Alice","id":"<1>"}',
			'{"ts":"2026-09-09T10:01:00.000Z","email":"c@x.com","status":"error","attempt":1,"error":"timeout"}',
			'{"ts":"2026-09-09T10:02:00.000Z","email":"d@x.com","status":"sending","attempt":1}',
			"",
		].join("\n"),
	});
	try {
		const h = makeIo();
		assertEquals(await runCli(["status", dir], h.io), 0);
		const text = h.out.join("\n");
		assertStringIncludes(
			text,
			"Recipients: 4 — 1 sent, 1 retry, 1 data-error, 1 unknown",
		);
		assertStringIncludes(text, "Skipped CSV rows: row 3 duplicate of A@X.COM");
		assertStringIncludes(text, "✓ sent       a@x.com  2026-09-09 10:00  Hello Alice");
		assertStringIncludes(text, "! data-error b@x.com  empty: NAME");
		assertStringIncludes(text, "↻ retry      c@x.com  1× error: timeout");
		assertStringIncludes(
			text,
			"? unknown    d@x.com  interrupted mid-send 2026-09-09 10:02",
		);

		const j = makeIo();
		assertEquals(await runCli(["status", dir, "--json"], j.io), 0);
		const parsed = JSON.parse(j.out[0]);
		assertEquals(parsed.ok, true);
		assertEquals(parsed.counts.sent, 1);
		assertEquals(parsed.items[0], {
			email: "a@x.com",
			address: "a@x.com",
			row: 1,
			status: "sent",
			attempts: 0,
			sentAt: "2026-09-09T10:00:00.000Z",
			id: "<1>",
		});
		assertEquals(parsed.items[2].lastError, "timeout");
		assertEquals(parsed.items[3].interruptedAt, "2026-09-09T10:02:00.000Z");
	} finally {
		await cleanup();
	}
});

Deno.test("cli status: corrupt ledger / missing template column → exit 2", async () => {
	const bad = await makeCampaignDir({ ledger: "garbage\n" });
	const col = await makeCampaignDir({ subject: "Hi ${TITLE}" });
	try {
		let h = makeIo();
		assertEquals(await runCli(["status", bad.dir], h.io), 2);
		assertStringIncludes(h.err[0], "log.jsonl line 1");
		h = makeIo();
		assertEquals(await runCli(["status", col.dir], h.io), 2);
		assertStringIncludes(h.err[0], "TITLE");
	} finally {
		await bad.cleanup();
		await col.cleanup();
	}
});

// --- preview ---------------------------------------------------------------

Deno.test("cli preview: first row by default, --to, json, placeholder sender", async () => {
	const { dir, cleanup } = await makeCampaignDir({ html: "<b>${NAME}</b>" });
	try {
		let h = makeIo();
		assertEquals(await runCli(["preview", dir], h.io), 0);
		let text = h.out.join("\n");
		assertStringIncludes(text, "To:       a@x.com");
		assertStringIncludes(text, "From:     <SMTP_FROM not set>");
		assertStringIncludes(text, "Subject:  Hello Alice");
		assertStringIncludes(text, "Status:   pending");
		assertStringIncludes(text, "Dear Alice,");
		assertStringIncludes(text, "--- html (12 chars) ---\n<b>Alice</b>");

		await Deno.writeTextFile(
			join(dir, ".env"),
			"SMTP_FROM=Me <me@x.com>\nSMTP_REPLY_TO=r@x.com\nBCC=me@x.com\n",
		);
		h = makeIo();
		assertEquals(await runCli(["preview", dir, "--to", "B@x.com"], h.io), 0);
		text = h.out.join("\n");
		assertStringIncludes(text, "To:       b@x.com");
		assertStringIncludes(text, "From:     Me <me@x.com>");
		assertStringIncludes(text, "Reply-To: r@x.com");
		assertStringIncludes(text, "Bcc:      me@x.com");

		h = makeIo();
		assertEquals(
			await runCli(["preview", dir, "--to", "c@x.com", "--json"], h.io),
			0,
		);
		const j = JSON.parse(h.out[0]);
		assertEquals(j.message.subject, "Hello Carol");
		assertEquals(j.status, "pending");

		h = makeIo();
		assertEquals(await runCli(["preview", dir, "--to", "zz@x.com"], h.io), 2);
		assertStringIncludes(h.err[0], "zz@x.com");
	} finally {
		await cleanup();
	}
});

// --- verify ----------------------------------------------------------------

Deno.test("cli verify: ok / missing SMTP_HOST / verify failure", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	const bare = await makeCampaignDir();
	try {
		let h = makeIo();
		assertEquals(await runCli(["verify", dir], h.io), 0);
		assertStringIncludes(h.out[0], "connection + auth OK (smtp.test:2525)");
		assertEquals(h.smtpOptions[0], { host: "smtp.test", port: 2525 });

		h = makeIo();
		assertEquals(await runCli(["verify", bare.dir], h.io), 2);
		assertStringIncludes(h.err[0], "SMTP_HOST");

		h = makeIo({ mock: { failOnVerify: true, errorMessage: "535 nope" } });
		assertEquals(await runCli(["verify", dir, "--json"], h.io), 1);
		assertEquals(JSON.parse(h.err[0]), { ok: false, error: "535 nope" });
	} finally {
		await cleanup();
		await bare.cleanup();
	}
});

// --- send ------------------------------------------------------------------

Deno.test("cli send --dry-run: renders through the mock, writes nothing, needs no SMTP config", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: "SMTP_FROM=me@x.com\n" });
	try {
		const h = makeIo();
		assertEquals(await runCli(["send", dir, "--dry-run"], h.io), 0);
		assertEquals(h.transports, []); // mock created internally, never via createTransport
		assertEquals(await readLedgerFile(dir), "");
		assertEquals(h.log.filter((l) => l.startsWith("[dry-run] ✓")).length, 3);
		assertStringIncludes(h.log[0], "[dry-run] ✓ 1/3 a@x.com  Hello Alice");
		assertEquals(h.stopped, ["[dry-run] done: 3 sent, 0 failed"]);
		assertEquals(h.confirms, []); // dry run never prompts
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: -y sends, writes the ledger; a second run is a no-op (idempotent)", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	try {
		const h = makeIo();
		assertEquals(await runCli(["send", dir, "-y"], h.io), 0);
		assertEquals(allSent(h).map((m) => m.to), ["a@x.com", "b@x.com", "c@x.com"]);
		assertEquals(allSent(h)[0].from, "Me <me@x.com>");
		assertEquals(h.transports[0].verifyCount, 1);
		assertStringIncludes(
			h.out.join("\n"),
			'Sending 3 emails as "Me <me@x.com>" via smtp.test:2525',
		);
		assertEquals(h.stopped, ["done: 3 sent, 0 failed"]);
		const ledger = (await readLedgerFile(dir)).trim().split("\n").map((l) =>
			JSON.parse(l)
		);
		assertEquals(ledger.map((e) => [e.email, e.status]), [
			["a@x.com", "sending"],
			["a@x.com", "sent"],
			["b@x.com", "sending"],
			["b@x.com", "sent"],
			["c@x.com", "sending"],
			["c@x.com", "sent"],
		]);

		const again = makeIo();
		assertEquals(await runCli(["send", dir, "-y"], again.io), 0);
		assertEquals(again.transports, []); // no transport even created
		assertStringIncludes(again.out.join("\n"), "Recipients: 3 — 3 sent");
		assertEquals(again.out.at(-1), "Nothing to send.");
		assertEquals((await readLedgerFile(dir)).trim().split("\n").length, 6);
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: confirmation — non-tty without -y refuses; interactive 'no' aborts cleanly", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	try {
		let h = makeIo();
		assertEquals(await runCli(["send", dir], h.io), 2);
		assertStringIncludes(h.err[0], "--yes");
		assertEquals(await readLedgerFile(dir), "");

		h = makeIo({ isInteractive: () => true, confirm: () => false });
		assertEquals(await runCli(["send", dir], h.io), 0);
		assertEquals(h.out.at(-1), "Aborted, nothing sent.");
		assertEquals(h.transports, []);

		h = makeIo({ isInteractive: () => true });
		assertEquals(await runCli(["send", dir], h.io), 0);
		assertEquals(h.confirms, [
			'Send 3 emails as "Me <me@x.com>" via smtp.test:2525?',
		]);
		assertEquals(allSent(h).length, 3);
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: failures → exit 1, retried on re-run, gave up after MAX_ATTEMPTS", async () => {
	const { dir, cleanup } = await makeCampaignDir({
		env: SMTP_ENV + "MAX_ATTEMPTS=2\n",
		recipients: "EMAIL,NAME\na@x.com,Alice\n",
	});
	try {
		let h = makeIo({ mock: { failOnSend: true, errorMessage: "451 busy" } });
		assertEquals(await runCli(["send", dir, "-y"], h.io), 1);
		assertStringIncludes(h.log.join("\n"), "✗ 1/1 a@x.com  attempt 1: 451 busy");
		assertEquals(h.stopped, ["done: 0 sent, 1 failed"]);

		h = makeIo({ mock: { failOnSend: true, errorMessage: "451 busy" } });
		assertEquals(await runCli(["send", dir, "-y"], h.io), 1);
		assertStringIncludes(h.out.join("\n"), "1 retry");
		assertStringIncludes(h.log.join("\n"), "attempt 2 (gave up): 451 busy");

		h = makeIo();
		assertEquals(await runCli(["send", dir, "-y"], h.io), 0);
		assertStringIncludes(h.out.join("\n"), "1 gave-up");
		assertEquals(h.out.at(-1), "Nothing to send.");

		const s = makeIo();
		await runCli(["status", dir], s.io);
		assertStringIncludes(
			s.out.join("\n"),
			"✗ gave-up    a@x.com  2× error: 451 busy",
		);

		// --max-attempts on the CLI raises the bar → retry again.
		h = makeIo();
		assertEquals(await runCli(["send", dir, "-y", "--max-attempts", "3"], h.io), 0);
		assertEquals(allSent(h).length, 1);
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: --limit then continue; --only; --only already sent is explained", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	try {
		let h = makeIo();
		assertEquals(await runCli(["send", dir, "-y", "--limit", "1"], h.io), 0);
		assertEquals(allSent(h).map((m) => m.to), ["a@x.com"]);

		h = makeIo();
		assertEquals(
			await runCli(["send", dir, "-y", "--only", "c@x.com,a@x.com"], h.io),
			0,
		);
		assertEquals(allSent(h).map((m) => m.to), ["c@x.com"]);
		assertStringIncludes(h.out.join("\n"), "✓ a@x.com: sent — skipped");

		h = makeIo();
		assertEquals(
			await runCli(["send", dir, "-y", "--only", "nobody@x.com"], h.io),
			2,
		);
		assertStringIncludes(h.err[0], "nobody@x.com");

		h = makeIo();
		assertEquals(await runCli(["send", dir, "-y"], h.io), 0);
		assertEquals(allSent(h).map((m) => m.to), ["b@x.com"]);

		h = makeIo();
		assertEquals(await runCli(["send", dir, "-y", "--limit", "x"], h.io), 2);
		assertStringIncludes(h.err[0], "--limit");
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: config problems fail before the prompt and before any transport", async () => {
	const noFrom = await makeCampaignDir({ env: "SMTP_HOST=smtp.test\n" });
	const noHost = await makeCampaignDir({ env: "SMTP_FROM=me@x.com\n" });
	const blank = await makeCampaignDir({
		env: SMTP_ENV,
		recipients: "EMAIL,NAME\na@x.com,\nb@x.com,Bob\n",
	});
	try {
		let h = makeIo({ isInteractive: () => true });
		assertEquals(await runCli(["send", noFrom.dir], h.io), 2);
		assertStringIncludes(h.err[0], "SMTP_FROM");
		assertEquals(h.confirms, []);

		h = makeIo({ isInteractive: () => true });
		assertEquals(await runCli(["send", noHost.dir], h.io), 2);
		assertStringIncludes(h.err[0], "SMTP_HOST");
		assertEquals(h.confirms, []);

		// data-error rows are reported and excluded; the rest goes out.
		h = makeIo();
		assertEquals(await runCli(["send", blank.dir, "-y"], h.io), 0);
		assertStringIncludes(h.out.join("\n"), "1 pending, 1 data-error");
		assertEquals(allSent(h).map((m) => m.to), ["b@x.com"]);
	} finally {
		await noFrom.cleanup();
		await noHost.cleanup();
		await blank.cleanup();
	}
});

Deno.test("cli send: SMTP verify failure → exit 1, nothing sent, ledger untouched", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	try {
		const h = makeIo({
			mock: { failOnVerify: true, errorMessage: "535 bad credentials" },
		});
		assertEquals(await runCli(["send", dir, "-y"], h.io), 1);
		assertStringIncludes(h.err[0], "535 bad credentials");
		assertEquals(await readLedgerFile(dir), "");
		assertEquals(h.stopped.length, 1); // status line was stopped on the error path

		const nv = makeIo({ mock: { failOnVerify: true } });
		assertEquals(await runCli(["send", dir, "-y", "--no-verify"], nv.io), 0);
		assertEquals(allSent(nv).length, 3);
	} finally {
		await cleanup();
	}
});

Deno.test("cli send --json: single summary object, no transcript", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	try {
		const h = makeIo();
		assertEquals(await runCli(["send", dir, "-y", "--json"], h.io), 0);
		assertEquals(h.log, []);
		assertEquals(h.out.length, 1);
		const j = JSON.parse(h.out[0]);
		assertEquals(j.ok, true);
		assertEquals(j.sent, 3);
		assertEquals(j.results.length, 3);
		assertEquals(j.results[0].email, "a@x.com");
		assertEquals(j.results[0].status, "sent");

		const again = makeIo();
		assertEquals(await runCli(["send", dir, "-y", "--json"], again.io), 0);
		assertEquals(JSON.parse(again.out[0]).total, 0);
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: Ctrl-C once stops after the in-flight send; twice exits 130", async () => {
	const { dir, cleanup } = await makeCampaignDir({ env: SMTP_ENV });
	try {
		const h = makeIo();
		// Interrupt from inside the first send, i.e. while it is in flight.
		h.io.createTransport = (): EmailTransport => {
			const t = createMockTransport();
			h.transports.push(t);
			const real = t.send.bind(t);
			t.send = async (m) => {
				const r = await real(m);
				h.interrupt?.();
				return r;
			};
			return t;
		};
		assertEquals(await runCli(["send", dir, "-y"], h.io), 0);
		assertEquals(allSent(h).map((m) => m.to), ["a@x.com"]);
		assertStringIncludes(h.log.join("\n"), "Ctrl-C: finishing the current send");
		assertStringIncludes(h.log.join("\n"), "interrupted — stopped before 2/3");
		assertEquals(h.stopped, [
			"done: 1 sent, 0 failed, interrupted (2 not attempted)",
		]);
		assertEquals(h.interrupt, undefined); // handler unsubscribed
		const ledger = (await readLedgerFile(dir)).trim().split("\n");
		assertEquals(ledger.length, 2); // sending + sent for a@x.com only

		const h2 = makeIo();
		h2.io.createTransport = (): EmailTransport => {
			const t = createMockTransport();
			h2.transports.push(t);
			const real = t.send.bind(t);
			t.send = async (m) => {
				const r = await real(m);
				h2.interrupt?.();
				h2.interrupt?.(); // second press → hard exit requested
				return r;
			};
			return t;
		};
		await runCli(["send", dir, "-y"], h2.io);
		assertEquals(h2.exits, [130]);
	} finally {
		await cleanup();
	}
});

Deno.test("cli send: --env-file replaces <dir>/.env; process env wins", async () => {
	const { dir, cleanup } = await makeCampaignDir({
		env: "SMTP_HOST=dir.host\nSMTP_FROM=dir@x.com\n",
	});
	try {
		const shared = join(dir, "..", `bulk-email-shared-${crypto.randomUUID()}.env`);
		await Deno.writeTextFile(
			shared,
			"SMTP_HOST=shared.host\nSMTP_FROM=shared@x.com\nDELAY_MS=0\n",
		);
		try {
			const h = makeIo({
				env: (k) => (k === "SMTP_FROM" ? "proc@x.com" : undefined),
			});
			assertEquals(
				await runCli(["send", dir, "-y", "--env-file", shared], h.io),
				0,
			);
			assertEquals(h.smtpOptions[0].host, "shared.host");
			assertEquals(allSent(h)[0].from, "proc@x.com");
		} finally {
			await Deno.remove(shared);
		}
	} finally {
		await cleanup();
	}
});
