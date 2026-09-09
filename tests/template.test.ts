import { assertEquals, assertThrows } from "@std/assert";
import {
	assertStrictVariablesHaveColumns,
	extractCampaignVariables,
	extractTemplateVariables,
	findEmptyStrictVariables,
	renderEmail,
} from "../src/template.ts";
import { ConfigError, type Recipient } from "../src/types.ts";

const recipient = (context: Record<string, string>, row = 1): Recipient => ({
	email: (context.EMAIL ?? "x@y.com").toLowerCase(),
	address: context.EMAIL ?? "x@y.com",
	row,
	context,
});

Deno.test("extractTemplateVariables: braced, unbraced, fallbacks, assertions, escapes", () => {
	const vars = extractTemplateVariables(
		"Hi ${NAME}, $CITY, ${REGION:-Europe}, ${OPT-x}, ${FLAG:+yes}, ${ID:?required}, ${ID!}, $$100 $$NOT, ${lower}",
	);
	assertEquals(vars, [
		{ name: "NAME", strict: true },
		{ name: "CITY", strict: true },
		{ name: "REGION", strict: false },
		{ name: "OPT", strict: false },
		{ name: "FLAG", strict: false },
		{ name: "ID", strict: true },
		{ name: "lower", strict: true },
	]);
});

Deno.test("extractTemplateVariables: a name is strict if any reference is strict", () => {
	assertEquals(extractTemplateVariables("${A:-x} and ${A}"), [{
		name: "A",
		strict: true,
	}]);
	assertEquals(extractTemplateVariables("${A} and ${A:-x}"), [{
		name: "A",
		strict: true,
	}]);
});

Deno.test("extractTemplateVariables: exact column key wins over operator parsing", () => {
	assertEquals(extractTemplateVariables("${my-var}", ["my-var"]), [{
		name: "my-var",
		strict: true,
	}]);
	assertEquals(extractTemplateVariables("${my-var}"), [{ name: "my", strict: false }]);
});

Deno.test("extractTemplateVariables: lowercase unbraced is literal, unterminated brace ignored", () => {
	assertEquals(extractTemplateVariables("$name and ${OPEN"), []);
	assertEquals(extractTemplateVariables("price $5 and $ alone"), []);
});

Deno.test("extractCampaignVariables: merges subject/text/html", () => {
	assertEquals(
		extractCampaignVariables({ subject: "${A}", text: "${B:-x}", html: "${B} ${C}" }),
		[{ name: "A", strict: true }, { name: "B", strict: true }, {
			name: "C",
			strict: true,
		}],
	);
});

Deno.test("assertStrictVariablesHaveColumns: passes / throws naming the missing ones", () => {
	assertStrictVariablesHaveColumns({ subject: "${A}", text: "${B:-x} ${C}" }, [
		"A",
		"C",
		"EMAIL",
	]);
	const e = assertThrows(
		() =>
			assertStrictVariablesHaveColumns({ subject: "${A} ${D}", text: "${B:-x}" }, [
				"A",
				"EMAIL",
			]),
		ConfigError,
	);
	assertEquals(e.message.includes("D"), true);
	assertEquals(e.message.includes("${D:-fallback}"), true);
});

Deno.test("findEmptyStrictVariables: blank or missing strict values; fallbacks ignored", () => {
	const tpl = { subject: "${NAME}", text: "${CITY:-BA} ${TITLE}" };
	assertEquals(
		findEmptyStrictVariables(
			tpl,
			recipient({ EMAIL: "a@b.com", NAME: " ", CITY: "" }),
			["EMAIL", "NAME", "CITY", "TITLE"],
		),
		["NAME", "TITLE"],
	);
	assertEquals(
		findEmptyStrictVariables(
			tpl,
			recipient({ EMAIL: "a@b.com", NAME: "X", TITLE: "Dr." }),
			["EMAIL", "NAME", "CITY", "TITLE"],
		),
		[],
	);
});

Deno.test("renderEmail: interpolates, single-line subject, optional fields", () => {
	const r = renderEmail(
		{
			subject: "  Hello ${NAME}\n  again ",
			text: "Dear ${NAME},\n$$5 for ${CITY:-you}",
			html: "<b>${NAME}</b>",
		},
		recipient({ EMAIL: "A@B.com", NAME: "Müller" }),
		{
			from: "Me <me@x.com>",
			replyTo: "r@x.com",
			bcc: "me@x.com",
			delayMs: 0,
			maxAttempts: 1,
		},
	);
	assertEquals(r, {
		to: "A@B.com",
		from: "Me <me@x.com>",
		subject: "Hello Müller again",
		text: "Dear Müller,\n$5 for you",
		html: "<b>Müller</b>",
		replyTo: "r@x.com",
		bcc: "me@x.com",
	});
});

Deno.test("renderEmail: no html → no html key; no replyTo/bcc → absent", () => {
	const r = renderEmail({ subject: "s", text: "t" }, recipient({ EMAIL: "a@b.com" }), {
		from: "f@x.com",
		delayMs: 0,
		maxAttempts: 1,
	});
	assertEquals(Object.keys(r).sort(), ["from", "subject", "text", "to"]);
});

Deno.test("renderEmail: missing from → ConfigError", () => {
	assertThrows(
		() =>
			renderEmail({ subject: "s", text: "t" }, recipient({ EMAIL: "a@b.com" }), {
				delayMs: 0,
				maxAttempts: 1,
			}),
		ConfigError,
		"SMTP_FROM",
	);
});

Deno.test("renderEmail: interpolate assertion → ConfigError with row + email", () => {
	const e = assertThrows(
		() =>
			renderEmail(
				{ subject: "s", text: "${X:?X is required}" },
				recipient({ EMAIL: "a@b.com" }, 7),
				{
					from: "f@x.com",
					delayMs: 0,
					maxAttempts: 1,
				},
			),
		ConfigError,
	);
	assertEquals(e.message, "row 7 (a@b.com): X is required");
});
