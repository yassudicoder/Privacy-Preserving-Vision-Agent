import { describe, expect, it } from 'vitest';
import type { PanelEvent } from '@/contracts/index.ts';
import { reduceAll } from '@/panel/index.ts';
// A deep import, as `chat.test.tsx` already does for `App`. The strip selector is
// not part of the panel's public surface, and widening that surface so a test
// can reach it is the wrong trade.
import { shieldSummary } from '@/panel/selectors.ts';

/**
 * A cloud send is WIRE. It used to be green.
 *
 * The panel's colour key is the website's: green means "stayed on this device",
 * cyan means "crossed the line". The Send stage used one tone, `ok`, for both a
 * cloud delivery and on-device planning - so the one moment the sanitized
 * context LEFT the machine rendered in the same green as work that never left
 * it. The same error was repeated in the timeline's delivery row. These pin both
 * halves, so the colour cannot quietly go back to asserting "safe" for a send.
 */

function transmitted(channel: 'cloud' | 'on-device') {
  const event: PanelEvent = { type: 'context/transmitted', channel, modelId: 'gpt-5.6-luna' };
  return reduceAll([event]);
}

describe('the strip colours a send by which side of the line it landed on', () => {
  it('a cloud send is WIRE, not device-green', () => {
    const send = shieldSummary(transmitted('cloud')).stages.find((s) => s.key === 'send');
    expect(send?.tone).toBe('sent');
  });

  it('on-device planning stays DEVICE green - nothing crossed the line', () => {
    const send = shieldSummary(transmitted('on-device')).stages.find((s) => s.key === 'send');
    expect(send?.tone).toBe('ok');
  });

  it('sent rolls up like ok: a different colour, not a lower grade', () => {
    // The sanitized context is SUPPOSED to be sent. A strip that turned amber or
    // red on every successful cloud step would teach a reader to ignore it.
    const summary = shieldSummary(transmitted('cloud'));
    expect(summary.tone).toBe('ok');
    expect(summary.tone).not.toBe('warn');
    expect(summary.tone).not.toBe('bad');
  });
});

describe('the timeline delivery row agrees with the strip', () => {
  it('a cloud delivery is a WIRE row', () => {
    const s = transmitted('cloud');
    const row = s.timeline[s.timeline.length - 1];
    expect(row?.label).toBe('privacy gate');
    expect(row?.kind).toBe('sent');
  });

  it('an on-device plan is a DEVICE row, as redaction work is', () => {
    const s = transmitted('on-device');
    const row = s.timeline[s.timeline.length - 1];
    expect(row?.label).toBe('local planner');
    expect(row?.kind).toBe('redaction');
  });
});
