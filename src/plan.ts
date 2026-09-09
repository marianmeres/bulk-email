/**
 * Reconciles a campaign against its ledger into a {@link Plan}: who has been
 * sent, who will be sent, who is blocked and why. `status` prints it,
 * `send` confirms it and then runs its `queue`.
 *
 * @module
 */

import {
	assertStrictVariablesHaveColumns,
	findEmptyStrictVariables,
} from "./template.ts";
import type { Campaign, LedgerState, Plan, PlanItem, PlanStatus } from "./types.ts";

/** Builds an all-zero counts record. */
function emptyCounts(): Record<PlanStatus, number> {
	return { pending: 0, retry: 0, sent: 0, "gave-up": 0, "data-error": 0, unknown: 0 };
}

/**
 * Computes the plan.
 *
 * Precedence per recipient: `sent` › `unknown` › `gave-up` › `data-error` ›
 * `retry` › `pending`. A delivered message is final whatever else happened;
 * an interrupted send must be resolved by a human before anything else; a
 * data problem is only worth reporting for someone we would otherwise send to.
 *
 * @param campaign - Loaded campaign.
 * @param ledger - Parsed ledger state.
 * @param maxAttempts - Failed attempts after which a recipient is `gave-up`.
 * @throws {ConfigError} when a strict template variable has no CSV column.
 */
export function planCampaign(
	campaign: Campaign,
	ledger: LedgerState,
	maxAttempts: number,
): Plan {
	assertStrictVariablesHaveColumns(campaign.templates, campaign.columns);

	const items: PlanItem[] = [];
	const counts = emptyCounts();

	for (const recipient of campaign.recipients) {
		const rec = ledger.records.get(recipient.email);
		const attempts = rec?.errors.length ?? 0;
		const item: PlanItem = { recipient, status: "pending", attempts };
		if (attempts > 0) item.lastError = rec!.errors[attempts - 1].error;

		if (rec?.sent) {
			item.status = "sent";
			item.sentEntry = rec.sent;
		} else if (rec?.dangling) {
			item.status = "unknown";
			item.danglingEntry = rec.dangling;
		} else if (attempts >= maxAttempts) {
			item.status = "gave-up";
		} else {
			const empty = findEmptyStrictVariables(
				campaign.templates,
				recipient,
				campaign.columns,
			);
			if (empty.length > 0) {
				item.status = "data-error";
				item.emptyVariables = empty;
			} else {
				item.status = attempts > 0 ? "retry" : "pending";
			}
		}

		counts[item.status]++;
		items.push(item);
	}

	return {
		items,
		queue: items.filter((i) => i.status === "pending" || i.status === "retry"),
		counts,
		skipped: campaign.skipped,
	};
}
