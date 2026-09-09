/**
 * Refuses to publish while `deno.json` maps a dependency to a local path.
 *
 * During development `@marianmeres/send-email` may point at `../send-email/…`
 * (see AGENTS.md). `deno publish --dry-run` does not catch that, but the
 * published package would be broken. Run before `deno publish`.
 */
const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));
const imports: Record<string, string> = denoJson.imports ?? {};
const local = Object.entries(imports).filter(([, v]) =>
	v.startsWith("./") || v.startsWith("../")
);
if (local.length > 0) {
	console.error("Refusing to publish: deno.json maps dependencies to local paths:");
	for (const [k, v] of local) console.error(`  ${k} → ${v}`);
	console.error("Point them at jsr:/npm: specifiers first.");
	Deno.exit(2);
}
console.log("preflight ok: no local-path imports");
