import { z } from "zod";

/**
 * Engineering Change Contract — the typed bridge between understanding and doing.
 * Every field is required (no optionals) so the JSON schema is strict enough for
 * structured output; use empty arrays / nulls for "nothing".
 */
export const CertaintySchema = z.enum(["confirmed", "supported", "hypothesized"]);
export const EnforcementSchema = z.enum(["blocking", "advisory"]);
export const DecisionRouteSchema = z.enum(["implement", "clarify", "abstain"]);

export const RequirementSchema = z.object({
  id: z.string().describe("REQ-### identifier, unique within the contract"),
  statement: z.string().describe("What must become true, in product terms"),
  evidence_ids: z.array(z.string()).describe("Evidence IDs from the evidence pack supporting this requirement; empty when derived from the task text alone"),
  certainty: CertaintySchema,
});

export const InvariantRefSchema = z.object({
  id: z.string().describe("INV-### id from the evidence pack"),
  evidence_ids: z.array(z.string()),
  enforcement: EnforcementSchema,
});

export const ReuseCandidateSchema = z.object({
  symbol_id: z.string().describe("Symbol node id from the evidence pack, e.g. SY:app.services.pricing.PricingService"),
  action: z.enum(["must_reuse", "consider_reuse", "avoid_duplicate"]),
  evidence_ids: z.array(z.string()),
  rationale: z.string(),
});

export const ArchitectureConstraintRefSchema = z.object({
  id: z.string().describe("ARCH-### id from the evidence pack"),
  evidence_ids: z.array(z.string()),
  enforcement: EnforcementSchema,
});

export const VerificationRefSchema = z.object({
  id: z.string().describe("VER-### identifier unique within the contract"),
  command_id: z.string().describe("Must be one of the trusted command ids listed in the evidence pack"),
  origin: z.literal("trusted_config"),
});

export const OpenQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  blocking: z.boolean().describe("true when implementation would require inventing business policy to proceed"),
});

export const ChangeContractSchema = z.object({
  schema_version: z.literal("1.0"),
  task_id: z.string(),
  goal: z.string(),
  decision: DecisionRouteSchema,
  base_revision: z.string().describe("Must equal the indexed revision in the evidence pack"),
  requirements: z.array(RequirementSchema),
  business_invariants: z.array(InvariantRefSchema),
  reuse_candidates: z.array(ReuseCandidateSchema),
  architecture_constraints: z.array(ArchitectureConstraintRefSchema),
  affected_modules: z.array(z.string()).describe("Repository-relative file paths likely to change"),
  allowed_paths: z.array(z.string()).describe("Globs the implementer may edit; must fall within the allowed path universe"),
  protected_paths: z.array(z.string()).describe("Globs that must not be edited; must include the policy's protected paths"),
  verification: z.array(VerificationRefSchema),
  open_questions: z.array(OpenQuestionSchema),
  rationale: z.string().describe("Why this decision (implement/clarify/abstain) follows from the evidence"),
  max_repairs: z.number().int().min(0).max(2),
});

export type ChangeContract = z.infer<typeof ChangeContractSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/** JSON schema handed to Codex as `outputSchema` (strict: all properties required, no additional). */
export function changeContractJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ChangeContractSchema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
