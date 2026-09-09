import { assertEquals, assertThrows } from "@std/assert";
import {
	buildLedgerState,
	loadLedgerState,
	parseLedger,
	parseLedgerLine,
	serializeLedgerEntry,
} from "../src/ledger.ts";
import { ConfigError, type LedgerEntry } from "../src/types.ts";

const e = (
	partial: Partial<LedgerEntry> & Pick<LedgerEntry, "email" | "status">,
): LedgerEntry => ({
	ts: "2026-09-09T10:00:00.000Z",
	attempt: 1,
	...partial,
});

Deno.test("serializeLedgerEntry: stable key order, optional keys only when set", () => {
	assertEquals(
		serializeLedgerEntry(e({ email: "a@b.com", status: "sending" })),
		'{"ts":"2026-09-09T10:00:00.000Z","email":"a@b.com","status":"sending","attempt":1}',
	);
	assertEquals(
		serializeLedgerEntry(
			e({ email: "a@b.com", status: "sent", subject: "Hi", id: "<1>" }),
		),
		'{"ts":"2026-09-09T10:00:00.000Z","email":"a@b.com","status":"sent","attempt":1,"subject":"Hi","id":"<1>"}',
	);
	assertEquals(
		serializeLedgerEntry(
			e({ email: "a@b.com", status: "error", attempt: 2, error: "boom" }),
		),
		'{"ts":"2026-09-09T10:00:00.000Z","email":"a@b.com","status":"error","attempt":2,"error":"boom"}',
	);
});

Deno.test("parseLedger: round-trips, skips blank lines, normalizes email", () => {
	const text = [
		serializeLedgerEntry(e({ email: "A@B.com", status: "sending" })),
		"",
		"   ",
		serializeLedgerEntry(
			e({ email: "a@b.com", status: "sent", id: "<1>", subject: "S" }),
		),
		"",
	].join("\n");
	const entries = parseLedger(text);
	assertEquals(entries.length, 2);
	assertEquals(entries[0].email, "a@b.com");
	assertEquals(
		entries[1],
		e({ email: "a@b.com", status: "sent", id: "<1>", subject: "S" }),
	);
});

Deno.test("parseLedger: malformed lines → ConfigError with line number", () => {
	const good = serializeLedgerEntry(e({ email: "a@b.com", status: "sent" }));
	const cases: [string, string][] = [
		[`${good}\nnot json`, "line 2: not valid JSON"],
		["[1,2]", "line 1: expected a JSON object"],
		['{"email":"a@b.com","status":"sent","attempt":1}', 'missing "ts"'],
		['{"ts":"x","status":"sent","attempt":1}', 'missing "email"'],
		[
			'{"ts":"x","email":"a@b.com","status":"maybe","attempt":1}',
			'"status" must be one of',
		],
		[
			'{"ts":"x","email":"a@b.com","status":"sent","attempt":0}',
			'"attempt" must be a positive integer',
		],
		[
			'{"ts":"x","email":"a@b.com","status":"sent","attempt":"1"}',
			'"attempt" must be a positive integer',
		],
	];
	for (const [text, msg] of cases) {
		assertThrows(() => parseLedger(text), ConfigError, msg);
	}
});

Deno.test("parseLedgerLine: extra keys are ignored", () => {
	const entry = parseLedgerLine(
		'{"ts":"x","email":"a@b.com","status":"sent","attempt":1,"note":"hi"}',
		1,
	);
	assertEquals(entry, { ts: "x", email: "a@b.com", status: "sent", attempt: 1 });
});

Deno.test("buildLedgerState: sent wins, errors accumulate, dangling sending detected", () => {
	const state = buildLedgerState([
		e({ email: "ok@x.com", status: "sending" }),
		e({ email: "ok@x.com", status: "sent", id: "<1>" }),
		e({ email: "fail@x.com", status: "sending" }),
		e({ email: "fail@x.com", status: "error", error: "e1" }),
		e({ email: "fail@x.com", status: "sending", attempt: 2 }),
		e({ email: "fail@x.com", status: "error", attempt: 2, error: "e2" }),
		e({ email: "dead@x.com", status: "sending" }),
		e({ email: "late@x.com", status: "error", error: "e" }),
		e({ email: "late@x.com", status: "sent", attempt: 2, id: "<2>" }),
	]);
	assertEquals(state.records.get("ok@x.com")!.sent?.id, "<1>");
	assertEquals(state.records.get("ok@x.com")!.dangling, undefined);
	assertEquals(state.records.get("fail@x.com")!.errors.map((x) => x.error), [
		"e1",
		"e2",
	]);
	assertEquals(state.records.get("fail@x.com")!.sent, undefined);
	assertEquals(state.records.get("fail@x.com")!.dangling, undefined);
	assertEquals(state.records.get("dead@x.com")!.dangling?.status, "sending");
	assertEquals(state.records.get("late@x.com")!.sent?.id, "<2>");
	assertEquals(state.records.get("late@x.com")!.errors.length, 1);
});

Deno.test("loadLedgerState: empty text → empty state", () => {
	const s = loadLedgerState("");
	assertEquals(s.entries, []);
	assertEquals(s.records.size, 0);
});
