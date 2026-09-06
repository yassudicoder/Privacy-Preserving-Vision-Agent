// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scoreFixture } from '@/harness/index.ts';
import type { VisionDetection } from '@/contracts/index.ts';

/**
 * Can the benchmark tell two vision models apart?
 *
 * Until this test existed it could not. `scoreFixture` took the engine's
 * detections and immediately discarded them - `void visionDetections` - then
 * rescored from the fixture's recorded `*.vision.json`. Every candidate
 * therefore produced identical metric 1, 2 and 3 numbers, and the ranking was
 * decided entirely by latency and heap.
 *
 * That is a benchmark which cannot answer the one question it exists to answer,
 * and it would have reported a confident 1.000 for a model that detects nothing.
 * This project has met that shape of failure repeatedly: an instrument reporting
 * a healthy number for something it was not measuring.
 */

const FIXTURE = 'unlabelled-media';

/** What a working face detector returns on the unlabelled photograph. */
const FINDS_THE_FACE: readonly VisionDetection[] = [
  {
    id: 'v-face-1',
    kind: 'face',
    source: 'vision',
    confidence: 0.92,
    rect: { space: 'css-viewport', x: 132, y: 168, width: 64, height: 78 },
    label: 'face',
    evidence: { rule: 'vision-face', valueLength: 0, valueHash: '00000011' },
  } as VisionDetection,
];

/** What yolos-tiny returned on every real page measured: nothing. */
const FINDS_NOTHING: readonly VisionDetection[] = [];

describe('the benchmark distinguishes a model that works from one that does not', () => {
  it('scores a detector that finds the face above one that finds nothing', () => {
    /*
     * This fixture is the only one where that difference is visible. Every other
     * fixture labels its images with honest alt text, which IMG_VISUAL_RULES
     * matches by regex with no model involved - so a model swap changes nothing
     * there, and four of the five recorded `*.vision.json` files are `[]`.
     */
    const working = scoreFixture(FIXTURE, FINDS_THE_FACE, false);
    const blind = scoreFixture(FIXTURE, FINDS_NOTHING, false);

    expect(working.piiF1).toBeGreaterThan(blind.piiF1);
  });

  it('a blind model does not score a perfect PII F1 on a page whose only PII is a face', () => {
    // The number that used to be 1.000 regardless of the model.
    const blind = scoreFixture(FIXTURE, FINDS_NOTHING, false);
    expect(blind.piiF1).toBeLessThan(1);
  });

  it('a working detector is not penalised on redaction precision for finding it', () => {
    // Recall bought at the cost of precision is not a win: metric 3 is 20%.
    const working = scoreFixture(FIXTURE, FINDS_THE_FACE, false);
    expect(working.redactionPrecision).toBe(1);
  });

  it('punishes a detector that fires on the benign images', () => {
    /*
     * The precision half. `#chart` is a bar chart and `#logo` is a company mark;
     * rounded forms in logos are a classic false positive for weak face
     * detectors. A model that blacks these out is trading 20% of the score for
     * recall it did not need.
     */
    const trigger_happy: readonly VisionDetection[] = [
      ...FINDS_THE_FACE,
      {
        id: 'v-face-2',
        kind: 'face',
        source: 'vision',
        confidence: 0.88,
        rect: { space: 'css-viewport', x: 400, y: 180, width: 90, height: 90 },
        label: 'face',
        evidence: { rule: 'vision-face', valueLength: 0, valueHash: '00000012' },
      } as VisionDetection,
      {
        id: 'v-face-3',
        kind: 'face',
        source: 'vision',
        confidence: 0.86,
        rect: { space: 'css-viewport', x: 610, y: 146, width: 100, height: 100 },
        label: 'face',
        evidence: { rule: 'vision-face', valueLength: 0, valueHash: '00000013' },
      } as VisionDetection,
    ];

    const careful = scoreFixture(FIXTURE, FINDS_THE_FACE, false);
    const sloppy = scoreFixture(FIXTURE, trigger_happy, false);

    // Same recall, worse precision - so the sloppy model must not rank equal.
    expect(sloppy.redactionPrecision).toBeLessThanOrEqual(careful.redactionPrecision);
    expect(sloppy.piiF1).toBeLessThanOrEqual(careful.piiF1);
  });

  it('still defaults to the recorded boxes for every other caller', () => {
    // The threading is additive. A fixture scored without explicit boxes must
    // behave exactly as it did before.
    const recorded = scoreFixture('profile-pii', [], false);
    expect(recorded.visualContext).toBeGreaterThan(0);
  });
});
