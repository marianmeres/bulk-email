import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createMockTransport } from "@marianmeres/send-email";
import { buildLedgerState } from "../src/ledger.ts";
import { planCampaign } from "../src/plan.ts";
import { parseRecipients } from "../src/recipients.ts";
import { defaultSleep, jitter, runPlan, selectQueue } from "../src/run.ts";
import {
	type Campaign,
	type CampaignSettings,
	ConfigError,
	type LedgerEntry,
	type Plan,
	type RunEvent,
} from "../src/types.ts";

const SETTINGS: CampaignSettings = {
	from: "Me <me@x.com>",
	delayMs: 1000,
	maxAttempts: 2,
};

function campaign(csv = "EMAIL,NAME\na@x.com,A\nb@x.com,B\nc@x.com,C\n"): Campaign {
	return {
		templates: { subject: "Hi ${NAME}", text: "Dear ${NAME}" },
		...parseRecipients(csv),
	};
}

function fixture(
	csv?: string,
	entries: LedgerEntry[] = [],
): { campaign: Campaign; plan: Plan } {
	const c = campaign(csv);
	return {
		campaign: c,
		plan: planCampaign(c, buildLedgerState(entries), SETTINGS.maxAttempts),
	};
}

/** Collects ledger writes + events + sleeps; fixed clock and RNG. */
function harness() {
	const ledger: LedgerEntry[] = [];
	const events: RunEvent[] = [];
	const sleeps: number[] = [];
	let tick = 0;
	return {
		ledger,
		events,
		sleeps,
		opts: {
			appendLedger: (e: LedgerEntry) => {
				ledger.push(e);
				return Promise.resolve();
			},
			onEvent: (e: RunEvent) => void events.push(e),
			sleep: (ms: number) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
			now: () => new Date(Date.UTC(2026, 8, 9, 10, 0, tick++)),
			random: () => 0.5, // jitter → exactly delayMs
		},
	};
}

Deno.test("jitter: ±20 % around the base, 0 stays 0", () => {
	assertEquals(jitter(1000, () => 0), 800);
	assertEquals(jitter(1000, () => 0.5), 1000);
	assertEquals(jitter(1000, () => 0.999), 1200);
	assertEquals(jitter(0), 0);
});

Deno.test("defaultSleep: resolves after the timeout and immediately when aborted", async () => {
	const t0 = Date.now();
	await defaultSleep(20);
	assertEquals(Date.now() - t0 >= 15, true);
	const ac = new AbortController();
	const p = defaultSleep(10_000, ac.signal);
	ac.abort();
	await p; // must not hang
	const pre = new AbortController();
	pre.abort();
	await defaultSleep(10_000, pre.signal);
});

Deno.test("selectQueue: only + limit; unknown --only address → ConfigError", () => {
	const { plan } = fixture();
	assertEquals(selectQueue(plan, {}).length, 3);
	assertEquals(selectQueue(plan, { limit: 2 }).map((i) => i.recipient.email), [
		"a@x.com",
		"b@x.com",
	]);
	assertEquals(selectQueue(plan, { limit: 0 }), []);
	assertEquals(
		selectQueue(plan, { only: ["C@X.com", " b@x.com "] }).map((i) =>
			i.recipient.email
		),
		[
			"b@x.com",
			"c@x.com",
		],
	);
	assertEquals(selectQueue(plan, { only: ["c@x.com"], limit: 0 }), []);
	assertThrows(
		() => selectQueue(plan, { only: ["nobody@x.com"] }),
		ConfigError,
		"nobody@x.com",
	);
	assertThrows(() => selectQueue(plan, { limit: -1 }), ConfigError, "--limit");
});

Deno.test("selectQueue: --only for an already-sent recipient yields nothing (idempotent)", () => {
	const { plan } = fixture(undefined, [
		{ ts: "t", email: "a@x.com", status: "sent", attempt: 1, id: "<1>" },
	]);
	assertEquals(selectQueue(plan, { only: ["a@x.com"] }), []);
});

Deno.test("runPlan: happy path — ledger order, events, delays between (not after) sends", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	const transport = createMockTransport();

	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		...h.opts,
	});

	assertEquals(summary, {
		sent: 3,
		errors: 0,
		total: 3,
		aborted: false,
		dryRun: false,
	});
	assertEquals(transport.sentEmails.map((m) => [m.to, m.subject, m.text, m.from]), [
		["a@x.com", "Hi A", "Dear A", "Me <me@x.com>"],
		["b@x.com", "Hi B", "Dear B", "Me <me@x.com>"],
		["c@x.com", "Hi C", "Dear C", "Me <me@x.com>"],
	]);
	assertEquals(h.ledger.map((e) => [e.email, e.status, e.attempt]), [
		["a@x.com", "sending", 1],
		["a@x.com", "sent", 1],
		["b@x.com", "sending", 1],
		["b@x.com", "sent", 1],
		["c@x.com", "sending", 1],
		["c@x.com", "sent", 1],
	]);
	assertEquals(h.ledger[1].subject, "Hi A");
	assertEquals(h.ledger[1].id, "mock-1");
	assertEquals(h.ledger[0].ts < h.ledger[1].ts, true);
	assertEquals(h.sleeps, [1000, 1000]);
	assertEquals(h.events.map((e) => e.type), [
		"verifying",
		"start",
		"sending",
		"sent",
		"waiting",
		"sending",
		"sent",
		"waiting",
		"sending",
		"sent",
		"done",
	]);
	assertEquals(transport.verifyCount, 1);
});

Deno.test("runPlan: html / replyTo / bcc are forwarded when present", async () => {
	const c = campaign("EMAIL,NAME\na@x.com,A\n");
	c.templates.html = "<p>${NAME}</p>";
	const plan = planCampaign(c, buildLedgerState([]), 2);
	const h = harness();
	const transport = createMockTransport();
	await runPlan(plan, c.templates, {
		transport,
		settings: { ...SETTINGS, replyTo: "r@x.com", bcc: "me@x.com" },
		...h.opts,
	});
	const m = transport.getLastEmail()!;
	assertEquals([m.html, m.replyTo, m.bcc], ["<p>A</p>", "r@x.com", "me@x.com"]);
});

Deno.test("runPlan: a failing send is logged as error and the run continues", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	let calls = 0;
	const transport = createMockTransport();
	const realSend = transport.send.bind(transport);
	transport.send = (msg) => {
		calls++;
		if (calls === 2) return Promise.reject(new Error("451 try later"));
		return realSend(msg);
	};

	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		...h.opts,
	});

	assertEquals(summary.sent, 2);
	assertEquals(summary.errors, 1);
	const errorEntry = h.ledger.find((e) => e.status === "error")!;
	assertEquals(errorEntry.email, "b@x.com");
	assertEquals(errorEntry.error, "451 try later");
	const errorEvent = h.events.find((e) => e.type === "error")!;
	assertEquals(errorEvent.type === "error" && errorEvent.gaveUp, false); // attempt 1 of 2
});

Deno.test("runPlan: retry attempt numbering and gaveUp flag from the ledger", async () => {
	const { campaign, plan } = fixture("EMAIL,NAME\na@x.com,A\n", [
		{ ts: "t", email: "a@x.com", status: "error", attempt: 1, error: "e1" },
	]);
	assertEquals(plan.items[0].status, "retry");
	const h = harness();
	const transport = createMockTransport({ failOnSend: true, errorMessage: "again" });
	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		verify: false,
		...h.opts,
	});
	assertEquals(summary.errors, 1);
	assertEquals(h.ledger.map((e) => e.attempt), [2, 2]);
	const ev = h.events.find((e) => e.type === "error")!;
	assertEquals(ev.type === "error" && ev.gaveUp, true); // attempt 2 of max 2
});

Deno.test("runPlan: dry run — mock send, no ledger, no sleep, no verify", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	const transport = createMockTransport();
	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		dryRun: true,
		...h.opts,
	});
	assertEquals(summary.dryRun, true);
	assertEquals(summary.sent, 3);
	assertEquals(h.ledger, []);
	assertEquals(h.sleeps, []);
	assertEquals(transport.verifyCount, 0);
	assertEquals(
		h.events.some((e) => e.type === "waiting" || e.type === "verifying"),
		false,
	);
});

Deno.test("runPlan: verify failure aborts before any ledger write", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	const transport = createMockTransport({
		failOnVerify: true,
		errorMessage: "535 auth",
	});
	await assertRejects(
		() =>
			runPlan(plan, campaign.templates, {
				transport,
				settings: SETTINGS,
				...h.opts,
			}),
		Error,
		"535 auth",
	);
	assertEquals(h.ledger, []);
	assertEquals(transport.sentEmails, []);
});

Deno.test("runPlan: verify is skipped when the queue is empty", async () => {
	const { campaign, plan } = fixture("EMAIL,NAME\n");
	const h = harness();
	const transport = createMockTransport({ failOnVerify: true });
	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		...h.opts,
	});
	assertEquals(summary.total, 0);
	assertEquals(h.events.map((e) => e.type), ["start", "done"]);
});

Deno.test("runPlan: missing sender → ConfigError before verify / ledger", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	const transport = createMockTransport();
	await assertRejects(
		() =>
			runPlan(plan, campaign.templates, {
				transport,
				settings: { delayMs: 0, maxAttempts: 1 },
				...h.opts,
			}),
		ConfigError,
		"SMTP_FROM",
	);
	assertEquals(h.ledger, []);
	assertEquals(transport.verifyCount, 0);
});

Deno.test("runPlan: a render error anywhere in the queue aborts before the 1st send", async () => {
	// Bypass planCampaign (which would already flag the blank X) to exercise the
	// run loop's own fail-fast: every queued message is rendered up front.
	const c = campaign("EMAIL,NAME,X\na@x.com,A,1\nb@x.com,B,\n");
	c.templates.text = "${X:?X is required}";
	const items = c.recipients.map((recipient) => ({
		recipient,
		status: "pending" as const,
		attempts: 0,
	}));
	const plan: Plan = {
		items,
		queue: items,
		counts: {
			pending: 2,
			retry: 0,
			sent: 0,
			"gave-up": 0,
			"data-error": 0,
			unknown: 0,
		},
		skipped: [],
	};
	const h = harness();
	const transport = createMockTransport();
	await assertRejects(
		() => runPlan(plan, c.templates, { transport, settings: SETTINGS, ...h.opts }),
		ConfigError,
		"row 2 (b@x.com): X is required",
	);
	assertEquals(transport.sentEmails, []);
	assertEquals(h.ledger, []);
});

Deno.test("runPlan: limit and only narrow the queue", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	const transport = createMockTransport();
	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		only: ["c@x.com", "a@x.com"],
		limit: 1,
		...h.opts,
	});
	assertEquals(summary.total, 1);
	assertEquals(transport.sentEmails.map((m) => m.to), ["a@x.com"]);
});

Deno.test("runPlan: abort signal — finishes the in-flight send, skips the delay, stops", async () => {
	const { campaign, plan } = fixture();
	const h = harness();
	const ac = new AbortController();
	const transport = createMockTransport();
	const realSend = transport.send.bind(transport);
	transport.send = async (msg) => {
		const r = await realSend(msg);
		if (msg.to === "a@x.com") ac.abort(); // Ctrl-C arrives mid-send #1
		return r;
	};
	const summary = await runPlan(plan, campaign.templates, {
		transport,
		settings: SETTINGS,
		signal: ac.signal,
		...h.opts,
	});
	assertEquals(summary, { sent: 1, errors: 0, total: 3, aborted: true, dryRun: false });
	assertEquals(h.ledger.map((e) => e.status), ["sending", "sent"]);
	assertEquals(h.sleeps, []);
	assertEquals(h.events.map((e) => e.type), [
		"verifying",
		"start",
		"sending",
		"sent",
		"aborted",
		"done",
	]);
});

Deno.test("runPlan: appendLedger failure after send leaves a dangling 'sending' (surfaces as unknown)", async () => {
	const { campaign, plan } = fixture("EMAIL,NAME\na@x.com,A\n");
	const written: LedgerEntry[] = [];
	const transport = createMockTransport();
	await assertRejects(
		() =>
			runPlan(plan, campaign.templates, {
				transport,
				settings: SETTINGS,
				appendLedger: (e) => {
					if (e.status === "sent") {
						return Promise.reject(new Error("disk full"));
					}
					written.push(e);
					return Promise.resolve();
				},
			}),
		Error,
		"disk full",
	);
	assertEquals(transport.sentEmails.length, 1);
	const replan = planCampaign(campaign, buildLedgerState(written), 2);
	assertEquals(replan.items[0].status, "unknown");
});
