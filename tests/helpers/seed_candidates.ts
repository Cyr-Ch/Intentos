import { ingestProposals, type ProposeResult } from "../../src/propose.ts";

/**
 * A review list for the startup_billing fixture, the way the host agent's `propose` call would submit it after
 * reading the evidence digest: invariants bound to existing tests, one architecture rule, one frozen path and one
 * decision. Every reference exists in the fixture, so the Ingestor keeps all of them.
 */
export const SEED_PROPOSALS: unknown[] = [
  { title: "Cancelled contract gets no discount", statement: "A cancelled contract never receives any discount line, whatever its seat count.", category: "business_rule", confidence: "high", relevance: "high", applies_to_paths: ["app/services/pricing.py", "app/services/discounts.py"], test: { existing: "tests/test_locked_contract.py::test_cancelled_contract_gets_no_discount" } },
  { title: "Locked contracts", statement: "Locked contracts receive no discounts or promotions of any kind.", category: "business_rule", confidence: "high", relevance: "high", applies_to_paths: ["app/services/pricing.py"], test: { existing: "tests/test_locked_contract.py::test_locked_contract_gets_no_discount" }, sources: [{ path: "docs/business-policy.md", heading: "Locked contracts" }] },
  { kind: "architecture_rule", title: "app/domain must not import app/services", statement: "Domain objects must not depend on services or the API layer.", evidence: [{ type: "doc", ref: "docs/adr-001-pricing-ownership.md:12", excerpt: "Decision" }], rule: { kind: "forbidden_import", paths: ["app/domain/**"], forbidden_modules: ["app.services"] }, sources: [{ path: "docs/adr-001-pricing-ownership.md", heading: "Decision" }] },
  { kind: "decision", title: "ADR-003 supersedes ADR-002", statement: "Invoice exports go through the export service; the legacy adapter is deprecated (ADR-003 supersedes ADR-002).", evidence: [{ type: "doc", ref: "docs/adr-003-invoice-export-service.md:13", excerpt: "Decision" }], sources: [{ path: "docs/adr-003-invoice-export-service.md", heading: "Decision" }], status: "approved", supersedes: "ADR-002" },
  { title: "Declined payment leaves entitlements unchanged", statement: "A declined payment leaves the contract's entitlements exactly as they were.", category: "business_rule", confidence: "high", relevance: "high", applies_to_paths: ["app/services/subscriptions.py", "app/services/payments.py"], test: { existing: "tests/test_subscription_upgrade.py::test_declined_payment_leaves_entitlements_unchanged" } },
  { title: "Apply upgrade grants entitlements after payment", statement: "Applying an upgrade grants the new entitlements only once the payment is confirmed.", category: "business_rule", confidence: "high", relevance: "high", applies_to_paths: ["app/services/subscriptions.py", "app/services/entitlements.py"], test: { existing: "tests/test_subscription_upgrade.py::test_apply_upgrade_grants_entitlements_after_payment" } },
  { title: "Currency mismatch raises", statement: "Money arithmetic across two currencies raises instead of converting silently.", category: "robustness_rule", confidence: "high", relevance: "medium", applies_to_paths: ["app/domain/money.py"], test: { existing: "tests/test_money.py::test_currency_mismatch_raises" } },
  { title: "Unsupported format raises", statement: "Exporting an invoice in an unknown format raises a ValueError naming the format.", category: "robustness_rule", confidence: "medium", relevance: "low", applies_to_paths: ["app/services/exports.py"], test: { existing: "tests/test_exports.py::test_unsupported_format_raises" } },
  { title: "Locked until expires", statement: "A contract lock expires on its locked_until date; after that discounts apply again.", category: "business_rule", confidence: "medium", relevance: "medium", applies_to_paths: ["app/domain/contracts.py"], test: { existing: "tests/test_locked_contract.py::test_locked_until_expires" } },
  { kind: "frozen_paths", title: "app/legacy is frozen", statement: "The legacy export adapter must not receive new code.", evidence: [{ type: "doc", ref: "docs/adr-003-invoice-export-service.md:13", excerpt: "Decision" }], rule: { kind: "frozen_paths", paths: ["app/legacy/**"] }, sources: [{ path: "docs/adr-003-invoice-export-service.md", heading: "Decision" }] },
  { title: "Checkout applies the volume discount", statement: "A contract at or above the seat threshold receives the volume discount at checkout.", category: "business_rule", confidence: "high", relevance: "high", applies_to_paths: ["app/api/checkout.py", "app/services/pricing.py"], test: { existing: "tests/test_checkout.py::test_checkout_applies_volume_discount" } },
  { title: "Scheduled upgrade takes effect next cycle", statement: "A scheduled upgrade takes effect at the next billing cycle and does not touch entitlements before then.", category: "business_rule", confidence: "high", relevance: "high", applies_to_paths: ["app/services/subscriptions.py"], test: { existing: "tests/test_subscription_upgrade.py::test_schedule_upgrade_takes_effect_next_cycle_without_touching_entitlements" } },
];

/** Ingest the seed proposals into `<outDir>/suggestions.json` for the fixture at `repo`, running every cited test once. */
export async function seedCandidates(repo: string, outDir: string, policyFile: string): Promise<ProposeResult> {
  const res = await ingestProposals(repo, SEED_PROPOSALS, { outDir, policyFile });
  if (res.rejected.length) throw new Error(`seed proposals rejected: ${JSON.stringify(res.rejected, null, 1)}`);
  return res;
}
