/**
 * Composition. The one module allowed to see perception, redaction and
 * agent-server together, because running a step means calling all three in a
 * specific order - and that order is a privacy property, not an implementation
 * detail. It emits PanelEvents but never imports panel: what renders them is
 * not its concern.
 */
export { resetVisionBreaker, runAgentStep } from './step.ts';
export type {
  StepDeps,
  StepInput,
  StepResult,
  StepStage,
  SnapshotResult,
  ExecuteResult,
  TargetIdentity,
} from './step.ts';
export { runAgentLoop } from './loop.ts';
export type { LoopOptions, LoopResult, LoopDeps, StopReason } from './loop.ts';

export { resolveTarget, decideAttachment } from './attach.ts';
export type {
  FollowReason,
  ActiveTabInfo,
  CurrentAttachment,
  FollowTarget,
  AttachDecision,
  DecideInput,
} from './attach.ts';
