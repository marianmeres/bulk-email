import { assertEquals, assertThrows } from "@std/assert";
import { isPlausibleEmail, normalizeEmail, parseRecipients } from "../src/recipients.ts";
import { ConfigError } from "../src/types.ts";

Deno.test("normalizeEmail: trims and lower-cases", () => {
	assertEquals(normalizeEmail("  Foo.Bar@Example.COM "), "foo.bar@example.com");
});

Deno.test("isPlausibleEmail: loose but not silly", () => {
	for (const ok of ["a@b.co", "first.last+tag@sub.example.org", "ÁČ@example.org"]) {
		assertEquals(isPlausibleEmail(ok), true, ok);
	}
	for (
		const bad of [
			"",
			"   ",
			"nope",
			"@x.com",
			"a@",
			"a@b",
			"a b@c.com",
			"a@@b.com",
			"a@.com",
			"a@b.",
		]
	) {
		assertEquals(isPlausibleEmail(bad), false, bad);
	}
});

Deno.test("parseRecipients: header → context, EMAIL case-insensitive, values trimmed", () => {
	const r = parseRecipients("email, NAME ,City\n A@B.com , Müller , Zürich\n");
	assertEquals(r.columns, ["email", "NAME", "City"]);
	assertEquals(r.recipients.length, 1);
	assertEquals(r.recipients[0], {
		email: "a@b.com",
		address: "A@B.com",
		row: 1,
		context: { email: "A@B.com", NAME: "Müller", City: "Zürich" },
	});
	assertEquals(r.skipped, []);
});

Deno.test("parseRecipients: BOM, CRLF, quoted fields with commas/newlines", () => {
	const r = parseRecipients(
		'﻿EMAIL,NOTE\r\na@b.com,"hello, ""world""\r\nsecond line"\r\n',
	);
	assertEquals(r.recipients[0].context.NOTE, 'hello, "world"\r\nsecond line');
});

Deno.test("parseRecipients: duplicates (case-insensitive) → first wins, later skipped", () => {
	const r = parseRecipients("EMAIL,NAME\na@b.com,One\nA@B.COM,Two\nc@d.com,Three\n");
	assertEquals(r.recipients.map((x) => x.context.NAME), ["One", "Three"]);
	assertEquals(r.skipped, [{ row: 2, reason: "duplicate", email: "A@B.COM" }]);
});

Deno.test("parseRecipients: invalid addresses and blank rows are skipped and reported", () => {
	const r = parseRecipients(
		"EMAIL,NAME\n,NoMail\nnot-an-email,Bad\n,\n\n\nok@x.com,Fine\n",
	);
	assertEquals(r.recipients.map((x) => x.email), ["ok@x.com"]);
	assertEquals(r.skipped, [
		{ row: 1, reason: "invalid-email", email: "" },
		{ row: 2, reason: "invalid-email", email: "not-an-email" },
		{ row: 3, reason: "empty-row" },
		{ row: 4, reason: "empty-row" },
		{ row: 5, reason: "empty-row" },
	]);
});

Deno.test("parseRecipients: ragged rows — missing cells become empty strings", () => {
	const r = parseRecipients("EMAIL,NAME,CITY\na@b.com,Only\n");
	assertEquals(r.recipients[0].context, { EMAIL: "a@b.com", NAME: "Only", CITY: "" });
});

Deno.test("parseRecipients: no EMAIL column → ConfigError", () => {
	assertThrows(
		() => parseRecipients("MAIL,NAME\na@b.com,x\n"),
		ConfigError,
		"no EMAIL column",
	);
});

Deno.test("parseRecipients: empty file → ConfigError", () => {
	assertThrows(() => parseRecipients(""), ConfigError, "empty");
	assertThrows(() => parseRecipients("\n\n"), ConfigError, "empty");
});

Deno.test("parseRecipients: duplicate header → ConfigError", () => {
	assertThrows(
		() => parseRecipients("EMAIL,NAME,NAME\n"),
		ConfigError,
		"duplicate column",
	);
});

Deno.test("parseRecipients: header only → zero recipients, no error", () => {
	const r = parseRecipients("EMAIL,NAME\n");
	assertEquals(r.recipients, []);
	assertEquals(r.columns, ["EMAIL", "NAME"]);
});
