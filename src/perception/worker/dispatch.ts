import type { CapturedFrame, EngineConfig, PixelRedactionOp } from '@/contracts/index.ts';
import type { HostDispatch } from '../host/host.ts';
import type { WorkerRuntime } from './runtime.ts';

/**
 * The wire protocol between a host and its runtime.
 *
 * Both entrypoints need this mapping - the Firefox background page calls into an
 * in-page runtime, the Chrome offscreen document receives the same commands over
 * `runtime.sendMessage` - and neither is a place where logic can be tested. So
 * the switch lives here, in a module vitest can reach, and the entrypoints stay
 * thin wiring.
 *
 * Payloads arrive as `unknown` because on Chrome they have genuinely crossed a
 * JSON boundary. They are narrowed here rather than cast blindly: a malformed
 * payload produces a clear error naming the command, instead of a
 * `cannot read property of undefined` from three frames deeper.
 */

export interface BakePayload {
  readonly frameId: string;
  readonly ops: readonly PixelRedactionOp[];
  readonly quality: number;
}

function asRecord(payload: unknown, cmd: string): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`worker dispatch: "${cmd}" expects an object payload, got ${typeof payload}`);
  }
  return payload as Record<string, unknown>;
}

function asBakePayload(payload: unknown): BakePayload {
  const p = asRecord(payload, 'bake');
  const frameId = p['frameId'];
  const ops = p['ops'];
  const quality = p['quality'];
  if (typeof frameId !== 'string' || frameId === '') {
    throw new Error('worker dispatch: "bake" requires a non-empty frameId');
  }
  if (!Array.isArray(ops)) {
    throw new Error('worker dispatch: "bake" requires an ops array');
  }
  if (typeof quality !== 'number' || !Number.isFinite(quality)) {
    throw new Error('worker dispatch: "bake" requires a numeric quality');
  }
  return { frameId, ops: ops as readonly PixelRedactionOp[], quality };
}

/** Commands the runtime understands. Anything else is refused by name. */
export const RUNTIME_COMMANDS = [
  'init',
  'status',
  'detect',
  'retain',
  'bake',
  'release',
  'dispose',
] as const;

export function createRuntimeDispatch(runtime: WorkerRuntime): HostDispatch {
  return async (cmd: string, payload: unknown): Promise<unknown> => {
    switch (cmd) {
      case 'init': {
        /*
         * Two shapes accepted on purpose. `{ config, salt }` is what the
         * background sends; a bare config is what every existing caller and test
         * sends. Refusing the bare form would break them for no benefit, and the
         * salt is optional by design - `init` records that it was missing rather
         * than inventing one.
         */
        const rec = asRecord(payload, 'init');
        const inner = rec['config'];
        if (inner !== undefined && typeof inner === 'object' && inner !== null) {
          const salt = rec['salt'];
          return runtime.init(
            inner as unknown as EngineConfig,
            typeof salt === 'string' ? salt : undefined,
          );
        }
        return runtime.init(rec as unknown as EngineConfig);
      }
      case 'status':
        // No payload. Cheap enough to call on every panel refresh, which is the
        // point: the worker is the only context that KNOWS whether a model is
        // loaded, and on Chrome it outlives the one that asks.
        return runtime.status();
      case 'detect':
        return runtime.detect(asRecord(payload, 'detect') as unknown as CapturedFrame);
      case 'retain': {
        // Returns null rather than undefined: the offscreen envelope carries the
        // result through JSON, and `undefined` would arrive as a missing key.
        await runtime.retain(asRecord(payload, 'retain') as unknown as CapturedFrame);
        return null;
      }
      case 'bake': {
        const { frameId, ops, quality } = asBakePayload(payload);
        return runtime.bake(frameId, ops, quality);
      }
      case 'release': {
        const rec = asRecord(payload, 'release');
        const frameId = rec['frameId'];
        if (typeof frameId !== 'string' || frameId === '') {
          throw new Error('worker dispatch: "release" requires a frameId');
        }
        await runtime.release(frameId);
        return { ok: true };
      }
      case 'dispose':
        await runtime.dispose();
        return { ok: true };
      default:
        // Named, not swallowed. A silently ignored command would look like a
        // hung pipeline rather than a typo.
        throw new Error(
          `worker dispatch: unknown command "${cmd}" (expected one of ${RUNTIME_COMMANDS.join(', ')})`,
        );
    }
  };
}
