export {
  detectAmbiguity,
  narrowByClarification,
  type AmbiguityFinding,
  type AmbiguityOptions,
} from './ambiguity.ts';
export { TYPEABLE_ROLES } from './context.ts';
export {
  applyElementBudget,
  capText,
  estimateElementBytes,
  emptyBudgetReport,
  rankElement,
  DEFAULT_BUDGET_POLICY,
  type ApplyBudgetOptions,
  type ApplyBudgetResult,
  type BudgetReport,
  type DroppedElement,
  type ElementBudgetPolicy,
} from './budget.ts';
/**
 * The shared contract. Types and pure helpers only, zero runtime dependencies,
 * imported by every module. Nothing here may import from a module.
 *
 * Changing anything in this folder changes everyone's compile. Treat it as an
 * API, not as scratch space.
 */

export * from './brand.ts';
export * from './untrusted.ts';
export * from './hash.ts';
export * from './geometry.ts';
export * from './image.ts';
export * from './detection.ts';
export * from './redaction.ts';
export * from './vision.ts';
export * from './context.ts';
export * from './action.ts';
/*
 * The deployment axis and the egress gate.
 *
 * Both live in contracts because both must be reachable from `agent-server`,
 * which may import nothing else. That is not an accident of layering: the
 * egress check has to run inside the network client - the last code before a
 * socket write - and the client may only see contracts.
 */
export * from './analysis.ts';
export * from './deployment.ts';
export * from './egress.ts';
export * from './receipt.ts';
export * from './metrics.ts';
export * from './messages.ts';
export * from './errors.ts';
