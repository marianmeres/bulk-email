import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

// The npm artifact is the runtime-agnostic CORE only (mod.ts is its "." entry).
// campaign-fs.ts (Deno fs), cli.ts (@std/cli, cli-status-line, Deno globals)
// and main.ts (import.meta.main guard) are Deno/JSR-only and are excluded.

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	sourceFiles: [
		"mod.ts",
		"types.ts",
		"recipients.ts",
		"template.ts",
		"ledger.ts",
		"settings.ts",
		"plan.ts",
		"run.ts",
	],
	dependencies: versionizeDeps(
		["@marianmeres/send-email", "@marianmeres/interpolate", "@marianmeres/parse-csv"],
		denoJson,
	),
});
