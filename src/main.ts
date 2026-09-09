/**
 * JSR entry point for `@marianmeres/bulk-email`: library + CLI.
 *
 * Re-exports the runtime-agnostic core from {@link "./mod.ts"} plus the
 * Deno-only directory helpers from {@link "./campaign-fs.ts"}, and — when run
 * directly — the CLI:
 *
 * ```bash
 * deno run -A jsr:@marianmeres/bulk-email send ./my-campaign
 * deno run -A jsr:@marianmeres/bulk-email status ./my-campaign
 * ```
 *
 * Importing this module as a dependency has no side effects: `import.meta.main`
 * is `false`, so the CLI (and its Deno-only dependencies) is never loaded.
 *
 * The npm package is built from {@link "./mod.ts"} only.
 *
 * @module
 */

export * from "./mod.ts";
export * from "./campaign-fs.ts";

if (import.meta.main) {
	const { runCli } = await import("./cli.ts");
	Deno.exit(await runCli(Deno.args));
}
