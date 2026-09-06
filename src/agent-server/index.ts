/**
 * Sanitized context in, one action out. Public surface only - nothing outside
 * this module may reach into ./server, which is not part of the extension bundle.
 */
export { parseAction, parseRationale, extractJsonObjects } from './parse-action.ts';
export { validateAction, parseAndValidate } from './validate-action.ts';
export type { ValidateOptions } from './validate-action.ts';
export { renderPrompt, promptFingerprint, fenceIsIntact, FENCE_OPEN, FENCE_CLOSE } from './prompt.ts';
export { HttpAgentClient, UnimplementedAgentClient } from './client.ts';
export type { HttpClientOptions } from './client.ts';
export { LocalPlannerClient } from './local-planner.ts';
export type { LocalPlannerOptions, LocalPlanTrace } from './local-planner.ts';
/*
 * The deployment layer: one interface over on-device, local, private and cloud.
 * The four differ in destination only - the request body, the egress gate, the
 * parse and the validation are one code path shared by all of them.
 */
export {
  OnDeviceBackend,
  HttpAgentBackend,
  createAgentBackend,
  backendDescriptorFor,
  deriveBackendOrigin,
} from './backend.ts';
export type { AgentBackend, BackendFactoryOptions, HttpBackendOptions } from './backend.ts';
export { TEXT_ROLES, textIntent } from './text-intent.ts';
export {
  PROTOCOL_VERSION,
  MAX_REQUEST_BYTES,
  encodeRequest,
  requestBytes,
} from './protocol.ts';
export type { AgentClient, PlanRequest, PlanResponse, PlanError, PlanOutcome } from './protocol.ts';
export {
  deriveOriginPattern,
  requestServerOrigin,
  hasServerOrigin,
  revokeServerOrigin,
} from './origin.ts';
export type { OriginGrant, OriginResult, PermissionsApi } from './origin.ts';
