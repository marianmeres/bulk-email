import { assertEquals, assertThrows } from "@std/assert";
import { resolveCampaignSettings } from "../src/settings.ts";
import { ConfigError } from "../src/types.ts";

const envFrom = (rec: Record<string, string>) => (k: string) => rec[k];

Deno.test("resolveCampaignSettings: defaults", () => {
	assertEquals(resolveCampaignSettings(envFrom({})), {
		delayMs: 10_000,
		maxAttempts: 3,
	});
});

Deno.test("resolveCampaignSettings: env values, blanks treated as unset", () => {
	assertEquals(
		resolveCampaignSettings(envFrom({
			SMTP_FROM: " Me <me@x.com> ",
			SMTP_REPLY_TO: "",
			BCC: "copy@x.com",
			DELAY_MS: "0",
			MAX_ATTEMPTS: " 5 ",
		})),
		{ from: "Me <me@x.com>", bcc: "copy@x.com", delayMs: 0, maxAttempts: 5 },
	);
});

Deno.test("resolveCampaignSettings: overrides win over env; strings parsed", () => {
	assertEquals(
		resolveCampaignSettings(
			envFrom({ DELAY_MS: "1000", MAX_ATTEMPTS: "2", SMTP_FROM: "a@x.com" }),
			{
				delayMs: "250",
				maxAttempts: 4,
				from: "b@x.com",
			},
		),
		{ from: "b@x.com", delayMs: 250, maxAttempts: 4 },
	);
});

Deno.test("resolveCampaignSettings: malformed → ConfigError", () => {
	assertThrows(
		() => resolveCampaignSettings(envFrom({ DELAY_MS: "1e3" })),
		ConfigError,
		"DELAY_MS",
	);
	assertThrows(
		() => resolveCampaignSettings(envFrom({ DELAY_MS: "-1" })),
		ConfigError,
		"DELAY_MS",
	);
	assertThrows(
		() => resolveCampaignSettings(envFrom({ MAX_ATTEMPTS: "0" })),
		ConfigError,
		"MAX_ATTEMPTS",
	);
	assertThrows(
		() => resolveCampaignSettings(envFrom({}), { maxAttempts: 0 }),
		ConfigError,
		"--max-attempts",
	);
	assertThrows(
		() => resolveCampaignSettings(envFrom({}), { delayMs: 1.5 }),
		ConfigError,
		"--delay",
	);
	assertThrows(
		() => resolveCampaignSettings(envFrom({ PREVENT_THREADING: "maybe" })),
		ConfigError,
		"PREVENT_THREADING",
	);
});

Deno.test("resolveCampaignSettings: PREVENT_THREADING is boolean-ish, present only when on", () => {
	const resolve = (value: string, override?: boolean | string) =>
		resolveCampaignSettings(
			envFrom({ PREVENT_THREADING: value }),
			override === undefined ? {} : { preventThreading: override },
		);
	for (const on of ["true", " TRUE ", "1", "yes", "on"]) {
		assertEquals(resolve(on).preventThreading, true, on);
	}
	for (const off of ["false", "0", "no", "off", "", " "]) {
		assertEquals("preventThreading" in resolve(off), false, off);
	}
	// Overrides win in both directions; a blank override falls through to env.
	assertEquals("preventThreading" in resolve("true", false), false);
	assertEquals(resolve("false", "yes").preventThreading, true);
	assertEquals(resolve("on", " ").preventThreading, true);
});
