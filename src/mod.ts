/**
 * `@marianmeres/bulk-email` — runtime-agnostic core (the npm package's `.` entry).
 *
 * Everything here is pure or I/O-injected: parse a CSV string, extract and
 * check template variables, parse/serialize the JSONL ledger, reconcile a
 * campaign against the ledger into a plan, and run that plan through a
 * `@marianmeres/send-email` transport. Reading a campaign *directory* and the
 * CLI are Deno-only and live in {@link "./main.ts"} (the JSR entry).
 *
 * ```ts
 * import { loadLedgerState, parseRecipients, planCampaign, runPlan } from "@marianmeres/bulk-email";
 * ```
 *
 * @module
 */

export * from "./types.ts";
export * from "./recipients.ts";
export * from "./template.ts";
export * from "./ledger.ts";
export * from "./settings.ts";
export * from "./plan.ts";
export * from "./run.ts";
