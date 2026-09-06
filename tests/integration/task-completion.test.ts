// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Action, type CapturedFrame, type PanelEvent, redactionNonce } from '@/contracts/index.ts';
import { createInProcessDomPipeline, resolveDomPath } from '@/redaction/index.ts';
import { LocalPlannerClient } from '@/agent-server/index.ts';
import { executeAction } from '@/execution/index.ts';
import { runAgentStep } from '@/orchestrator/index.ts';
import type { CaptureAdapter } from '@/perception/index.ts';

/**
 * Does the PAGE change?
 *
 * Every other test in this repo asks whether `runAgentStep` returns `ok`. That
 * is not the same question, and the difference is exactly what was observed in
 * the browser: the pipeline captured, detected, redacted, sanitized, planned,
 * parsed, validated and executed - reporting success at every stage - while the
 * web page sat there unchanged.
 *
 * So this test asserts against a LIVE DOM, after the step, that the element the
 * agent was supposed to act on actually holds what it was supposed to hold.
 *
 * NOTHING IS HARDCODED TO THE TASK. The word "laptop" appears only in the goal
 * the user would type. The action is produced by the planner, serialised as a
 * raw string, and passed through `parseAction` and `validateAction` before it is
 * allowed anywhere near the document - the same gate a hostile server's output
 * faces.
 */

const FIXTURE = join(process.cwd(), 'src', 'harness', 'fixtures', 'benign-docs.html');
const HTML = readFileSync(FIXTURE, 'utf8');
const VIEWPORT = { cssWidth: 1280, cssHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 };

function capture(): CaptureAdapter {
  return {
    capture: (_tabId, viewport): Promise<CapturedFrame> =>
      Promise.resolve({
        frameId: 'f1',
        dataUrl: 'data:image/jpeg;base64,AA==',
        encodedBytes: 4,
        natural: { width: 1280, height: 800 },
        viewport,
        capturedAt: 1_700_000_000_000,
      }),
  };
}

/** A host that answers `detect`, `bake` and `release` without a model. */
const host = {
  kind: 'test' as const,
  isRunning: () => Promise.resolve(true),
  ensureStarted: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  request: <T,>(cmd: string): Promise<T> => {
    if (cmd === 'detect') {
      return Promise.resolve({
        frameId: 'f1',
        detections: [],
        backend: 'stub',
        modelId: 't',
        timings: { decodeMs: 0, inferMs: 0, postMs: 0, totalMs: 0 },
      } as unknown as T);
    }
    return Promise.resolve({ ok: true } as unknown as T);
  },
};

interface RunResult {
  readonly live: Document;
  readonly actions: { type: string; ref?: string }[];
  readonly executed: { ok: boolean; note: string }[];
  readonly paths: (string | null)[];
  readonly events: PanelEvent[];
  readonly stepOk: boolean;
  readonly stage: string | null;
}

/**
 * Runs one real step against a live document.
 *
 * `execute` is where the content script would be. It does what the content
 * script does: resolve the DOM path against the LIVE document, then run
 * `executeAction`. That is the seam the browser crosses, reproduced faithfully.
 */
async function runStepAgainstLiveDom(goal: string): Promise<RunResult> {
  const live = new DOMParser().parseFromString(HTML, 'text/html');
  const actions: { type: string; ref?: string }[] = [];
  const executed: { ok: boolean; note: string }[] = [];
  const paths: (string | null)[] = [];
  const events: PanelEvent[] = [];

  const result = await runAgentStep(
    {
      snapshot: () => Promise.resolve({ html: HTML, viewport: VIEWPORT }),
      capture: capture(),
      host: host as never,
      dom: createInProcessDomPipeline(),
      client: new LocalPlannerClient(),
      execute: (_tabId: number, action: Action, domPath: string | null) => {
        actions.push(action as unknown as { type: string; ref?: string });
        paths.push(domPath);
        const out = executeAction(action, {
          resolve: () =>
            domPath === null ? null : resolveDomPath(live, domPath as never),
          scrollBy: () => {},
          navigate: () => {},
        });
        executed.push(out);
        return Promise.resolve(out);
      },
      emit: (e: PanelEvent) => events.push(e),
    } as never,
    {
      tabId: 1,
      taskId: 'task-1',
      step: 1,
      goal,
      url: 'https://fixtures.invalid/benign-docs',
      nonce: redactionNonce('a1b2c3d4'),
      salt: 'test-salt',
      allowedOrigins: [],
      captureOptions: { format: 'jpeg', quality: 70, maxEdgePx: 1280 },
    } as never,
  );

  return {
    live,
    actions,
    executed,
    paths,
    events,
    stepOk: result.ok,
    stage: result.ok ? null : result.stage,
  };
}

describe('a text-entry goal actually changes the document', () => {
  it('types the goal text into the page search field', async () => {
    const before = new DOMParser().parseFromString(HTML, 'text/html');
    expect((before.querySelector('#q') as HTMLInputElement).value).toBe('');

    const run = await runStepAgainstLiveDom('search for laptop');

    if (!run.stepOk) throw new Error(`step failed at ${String(run.stage)}`);

    /*
     * THE ASSERTION THAT MATTERS. Not "the step returned ok" - the live input
     * holds the text. Everything upstream reported success while this was still
     * empty, which is the whole reason this file exists.
     */
    const field = run.live.querySelector('#q') as HTMLInputElement;
    expect(field.value).toBe('laptop');
  });

  it('got there by planning a type action, not by any shortcut', async () => {
    const run = await runStepAgainstLiveDom('search for laptop');
    // The action came from the planner and survived parse + validate.
    expect(run.actions).toHaveLength(1);
    expect(run.actions[0]?.type).toBe('type');
    // A ref was resolved to a real DOM path, which is the step that silently
    // fails when the redacted and live documents disagree.
    expect(run.paths[0]).not.toBeNull();
    expect(run.executed[0]?.ok).toBe(true);
  });

  it('derives the text from the goal rather than containing it', async () => {
    // Same code path, different goal. If "laptop" were hardcoded anywhere this
    // would still type "laptop".
    const run = await runStepAgainstLiveDom('search for standing desk');
    const field = run.live.querySelector('#q') as HTMLInputElement;
    expect(field.value).toBe('standing desk');
  });

  it('does not type when the goal names no text to enter', async () => {
    /*
     * "open the handbook" is a click-shaped goal. Inventing a query for it would
     * be worse than declining - the baseline must not put arbitrary text into a
     * page because it saw a field.
     */
    const run = await runStepAgainstLiveDom('open the handbook');
    const field = run.live.querySelector('#q') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(run.actions[0]?.type).not.toBe('type');
  });

  it('reports the executed action to the panel', async () => {
    const run = await runStepAgainstLiveDom('search for laptop');
    const executedEvent = run.events.find((e) => e.type === 'action/executed');
    expect(executedEvent).toBeDefined();
    expect((executedEvent as { ok: boolean }).ok).toBe(true);
  });
});

describe('sensitive fields are still off limits', () => {
  it('refuses to type into a field the redactor marked sensitive', async () => {
    /*
     * login-form's password box is sensitive. A goal that names text to enter
     * must not cause the baseline to fill it - it cannot judge whether that is
     * safe, and this project's position is that it does not get to.
     */
    const loginHtml = readFileSync(
      join(process.cwd(), 'src', 'harness', 'fixtures', 'login-form.html'),
      'utf8',
    );
    const live = new DOMParser().parseFromString(loginHtml, 'text/html');
    const typedInto: string[] = [];

    await runAgentStep(
      {
        snapshot: () => Promise.resolve({ html: loginHtml, viewport: VIEWPORT }),
        capture: capture(),
        host: host as never,
        dom: createInProcessDomPipeline(),
        client: new LocalPlannerClient(),
        execute: (_t: number, action: Action, domPath: string | null) => {
          if ((action as { type: string }).type === 'type') {
            typedInto.push(String(domPath));
          }
          const out = executeAction(action, {
            resolve: () => (domPath === null ? null : resolveDomPath(live, domPath as never)),
            scrollBy: () => {},
            navigate: () => {},
          });
          return Promise.resolve(out);
        },
      } as never,
      {
        tabId: 1,
        taskId: 't',
        step: 1,
        goal: 'enter hunter2',
        url: 'https://fixtures.invalid/login-form',
        nonce: redactionNonce('a1b2c3d4'),
        salt: 's',
        allowedOrigins: [],
        captureOptions: { format: 'jpeg', quality: 70, maxEdgePx: 1280 },
      } as never,
    );

    const password = live.querySelector('input[type="password"]') as HTMLInputElement | null;
    if (password !== null) expect(password.value).not.toBe('hunter2');
  });
});

describe('it enters the text once, not into every field it can find', () => {
  /*
   * THE FIELD-SPRAYING BUG, observed on a real page.
   *
   * "search for laptop" correctly typed `laptop` into the search box and the
   * search ran. Then, because the dedup was per-REF, the next step found the
   * next untried text field and typed into that one too - a payment form's
   * EXPIRY DATE - and the step after posted the query as a product review. Eight
   * steps, ending in max-steps.
   *
   * That is harmful rather than untidy: an agent that sprays the goal text into
   * every reachable field will eventually reach one that matters.
   */

  it('reports done once the text has been entered', async () => {
    const run = await runStepAgainstLiveDom('search for laptop');
    if (!run.stepOk) throw new Error(`step failed at ${String(run.stage)}`);

    // Second step, with the first recorded in history exactly as the loop does.
    const live = new DOMParser().parseFromString(HTML, 'text/html');
    const second = await runAgentStep(
      {
        snapshot: () => Promise.resolve({ html: HTML, viewport: VIEWPORT }),
        capture: capture(),
        host: host as never,
        dom: createInProcessDomPipeline(),
        client: new LocalPlannerClient(),
        execute: (_t: number, action: Action, domPath: string | null) =>
          Promise.resolve(
            executeAction(action, {
              resolve: () => (domPath === null ? null : resolveDomPath(live, domPath as never)),
              scrollBy: () => {},
              navigate: () => {},
            }),
          ),
      } as never,
      {
        tabId: 1,
        taskId: 'task-1',
        step: 2,
        goal: 'search for laptop',
        url: 'https://fixtures.invalid/benign-docs',
        nonce: redactionNonce('a1b2c3d4'),
        salt: 'test-salt',
        allowedOrigins: [],
        captureOptions: { format: 'jpeg', quality: 70, maxEdgePx: 1280 },
        history: [{ step: 1, actionType: 'type', ref: null, ok: true, note: '' }],
      } as never,
    );

    if (!second.ok) throw new Error('second step failed');
    // `done`, not another `type`. This is what ends the run at two steps instead
    // of eight, and what stops the second field being filled.
    expect(second.outcome.action?.type).toBe('done');
  });

  it('leaves every other text field on the page untouched', async () => {
    /*
     * The direct assertion. benign-docs has more than one text field; only the
     * one the planner chose may change.
     */
    const run = await runStepAgainstLiveDom('search for laptop');
    // Every text-bearing control, whatever its type attribute says.
    const fields = [...run.live.querySelectorAll('input, textarea')].filter(
      (f) => !['checkbox', 'radio', 'submit', 'button'].includes((f as HTMLInputElement).type),
    );
    const filled = fields.filter((f) => (f as HTMLInputElement).value !== '');
    expect(filled).toHaveLength(1);
    expect((filled[0] as HTMLInputElement).id).toBe('q');
  });
});

