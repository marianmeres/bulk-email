import { assertEquals, assertThrows } from "@std/assert";
import { buildLedgerState } from "../src/ledger.ts";
import { planCampaign } from "../src/plan.ts";
import { parseRecipients } from "../src/recipients.ts";
import { type Campaign, ConfigError, type LedgerEntry } from "../src/types.ts";

const e = (
	partial: Partial<LedgerEntry> & Pick<LedgerEntry, "email" | "status">,
): LedgerEntry => ({
	ts: "2026-09-09T10:00:00.000Z",
	attempt: 1,
	...partial,
});

function campaign(
	csv: string,
	subject = "Hi ${NAME}",
	text = "Dear ${NAME}, ${PS:-}",
): Campaign {
	return { templates: { subject, text }, ...parseRecipients(csv) };
}

const CSV = [
	"EMAIL,NAME",
	"sent@x.com,Sent",
	"pending@x.com,Pending",
	"retry@x.com,Retry",
	"gaveup@x.com,GaveUp",
	"blank@x.com,",
	"dead@x.com,Dead",
	"sentblank@x.com,",
	"deadblank@x.com,",
].join("\n");

const LEDGER = buildLedgerState([
	e({ email: "sent@x.com", status: "sent", id: "<1>", subject: "Hi Sent" }),
	e({ email: "retry@x.com", status: "error", error: "timeout" }),
	e({ email: "gaveup@x.com", status: "error", error: "e1" }),
	e({ email: "gaveup@x.com", status: "error", attempt: 2, error: "e2" }),
	e({ email: "gaveup@x.com", status: "error", attempt: 3, error: "e3" }),
	e({ email: "dead@x.com", status: "sending" }),
	e({ email: "sentblank@x.com", status: "sent", id: "<2>" }),
	e({ email: "deadblank@x.com", status: "sending" }),
]);

Deno.test("planCampaign: statuses, precedence, counts, queue order", () => {
	const plan = planCampaign(campaign(CSV), LEDGER, 3);
	assertEquals(
		plan.items.map((i) => [i.recipient.email, i.status, i.attempts]),
		[
			["sent@x.com", "sent", 0],
			["pending@x.com", "pending", 0],
			["retry@x.com", "retry", 1],
			["gaveup@x.com", "gave-up", 3],
			["blank@x.com", "data-error", 0],
			["dead@x.com", "unknown", 0],
			["sentblank@x.com", "sent", 0], // sent wins over the data problem
			["deadblank@x.com", "unknown", 0], // unknown wins over the data problem
		],
	);
	assertEquals(plan.counts, {
		sent: 2,
		pending: 1,
		retry: 1,
		"gave-up": 1,
		"data-error": 1,
		unknown: 2,
	});
	assertEquals(plan.queue.map((i) => i.recipient.email), [
		"pending@x.com",
		"retry@x.com",
	]);
	assertEquals(plan.items[2].lastError, "timeout");
	assertEquals(plan.items[3].lastError, "e3");
	assertEquals(plan.items[0].sentEntry?.id, "<1>");
	assertEquals(plan.items[4].emptyVariables, ["NAME"]);
	assertEquals(plan.items[5].danglingEntry?.status, "sending");
});

Deno.test("planCampaign: maxAttempts boundary", () => {
	const plan4 = planCampaign(campaign(CSV), LEDGER, 4);
	assertEquals(plan4.items[3].status, "retry"); // 3 errors < 4
	const plan1 = planCampaign(campaign(CSV), LEDGER, 1);
	assertEquals(plan1.items[2].status, "gave-up"); // 1 error >= 1
});

Deno.test("planCampaign: strict variable without a column → ConfigError before anything else", () => {
	assertThrows(
		() =>
			planCampaign(
				campaign("EMAIL,NAME\na@x.com,A\n", "Hi ${TITLE} ${NAME}"),
				buildLedgerState([]),
				3,
			),
		ConfigError,
		"TITLE",
	);
});

Deno.test("planCampaign: optional variable without a column is fine", () => {
	const plan = planCampaign(
		campaign("EMAIL,NAME\na@x.com,A\n", "Hi ${NAME}", "${PS:-none}"),
		buildLedgerState([]),
		3,
	);
	assertEquals(plan.queue.length, 1);
});

Deno.test("planCampaign: skipped CSV rows are carried through", () => {
	const plan = planCampaign(
		campaign("EMAIL,NAME\na@x.com,A\nA@X.COM,dup\n"),
		buildLedgerState([]),
		3,
	);
	assertEquals(plan.skipped, [{ row: 2, reason: "duplicate", email: "A@X.COM" }]);
});
