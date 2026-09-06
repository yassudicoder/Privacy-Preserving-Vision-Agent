import { describe, expect, it } from 'vitest';
import type { EngineConfig, RgbaImage } from '@/contracts/index.ts';
import {
  YUNET_STRIDES,
  YunetBackend,
  createYunetBackend,
  yunetProviders,
  type OrtApi,
  type OrtSessionLike,
  type OrtTensorLike,
} from '@/perception/index.ts';

/**
 * The raw-ORT backend, with no ORT.
 *
 * The library is injected, so every branch here is reachable in Node: the
 * session, the tensor factory and the weight fetch are all fakes. What is tested
 * is the wiring the real library cannot check for us - channel order, tensor
 * shape, output naming, and what happens when the model returns something
 * unexpected.
 */

const CONFIG: EngineConfig = {
  modelId: 'opencv/face_detection_yunet',
  preferredBackend: 'wasm',
  maxEdgePx: 640,
  scoreThreshold: 0.35,
  nmsIou: 0.45,
  timeoutMs: 5000,
  inferTimeoutMs: 4000,
};

const NO_PAD = { top: 0, left: 0, bottom: 0, right: 0 };

function counts(): number[] {
  return YUNET_STRIDES.map((s) => (640 / s) ** 2);
}

/** A session returning all twelve outputs, zero unless seeded. */
function fakeSession(over: { seed?: boolean; drop?: string; badType?: string } = {}) {
  const feedsSeen: Record<string, unknown>[] = [];
  const session: OrtSessionLike = {
    inputNames: ['input'],
    outputNames: [],
    run: (feeds) => {
      feedsSeen.push(feeds);
      const out: Record<string, OrtTensorLike> = {};
      YUNET_STRIDES.forEach((s, i) => {
        const n = counts()[i] ?? 0;
        const cls = new Float32Array(n);
        const obj = new Float32Array(n);
        const bbox = new Float32Array(n * 4);
        if (over.seed === true && i === 0) {
          cls[0] = 1;
          obj[0] = 1;
        }
        out[`cls_${String(s)}`] = { data: cls, dims: [1, n, 1] };
        out[`obj_${String(s)}`] = { data: obj, dims: [1, n, 1] };
        out[`bbox_${String(s)}`] = { data: bbox, dims: [1, n, 4] };
      });
      if (over.drop !== undefined) delete out[over.drop];
      if (over.badType !== undefined) out[over.badType] = { data: 'not a tensor', dims: [1] };
      return Promise.resolve(out);
    },
  };
  return { session, feedsSeen };
}

const api: OrtApi = {
  createSession: () => Promise.resolve(fakeSession().session),
  tensor: (data, dims) => ({ data, dims }),
};

function image(size = 640): RgbaImage {
  return { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
}

function backendWith(session: OrtSessionLike, inputSize = 640): YunetBackend {
  return new YunetBackend({
    backend: 'wasm',
    modelId: 'opencv/face_detection_yunet',
    weightBytes: 232_589,
    inputSize,
    session,
    api,
    inferTimeoutMs: 4000,
  });
}

describe('YunetBackend.infer', () => {
  it('feeds a [1,3,H,W] float tensor under the session input name', async () => {
    const { session, feedsSeen } = fakeSession();
    await backendWith(session).infer({ rgba: image(), inputSize: 640, scale: 1, pad: NO_PAD });
    const feed = feedsSeen[0]?.['input'] as { data: Float32Array; dims: number[] };
    expect(feed.dims).toEqual([1, 3, 640, 640]);
    expect(feed.data).toBeInstanceOf(Float32Array);
    expect(feed.data.length).toBe(640 * 640 * 3);
  });

  it('sends BGR, not RGB', async () => {
    /*
     * The one failure with no symptom. Measured through this exact code on a
     * real image: BGR found 66 faces, RGB found 11 - and the top score moved
     * only from 0.918 to 0.907, so the output looks healthy either way.
     */
    const { session, feedsSeen } = fakeSession();
    const img = image(1);
    img.data.set([10, 20, 30, 255]); // r, g, b, a
    await backendWith(session, 1).infer({ rgba: img, inputSize: 1, scale: 1, pad: NO_PAD });
    const feed = feedsSeen[0]?.['input'] as { data: Float32Array };
    expect([...feed.data]).toEqual([30, 20, 10]);
  });

  it('returns boxes decoded from the strides', async () => {
    const { session } = fakeSession({ seed: true });
    const boxes = await backendWith(session).infer({
      rgba: image(),
      inputSize: 640,
      scale: 1,
      pad: NO_PAD,
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.label).toBe('face');
    expect(boxes[0]?.score).toBeCloseTo(1, 6);
  });

  it('refuses an input that is not the square the session wants', async () => {
    // letterboxImage should have produced exactly this size. A mismatch returns
    // boxes in a space undoLetterbox cannot invert - plausible, wrong, and
    // invisible downstream.
    const { session } = fakeSession();
    await expect(
      backendWith(session).infer({ rgba: image(320), inputSize: 320, scale: 1, pad: NO_PAD }),
    ).rejects.toThrow(/320x320/);
  });

  it('names the missing output when the model returns an unexpected set', async () => {
    const { session } = fakeSession({ drop: 'bbox_16' });
    await expect(
      backendWith(session).infer({ rgba: image(), inputSize: 640, scale: 1, pad: NO_PAD }),
    ).rejects.toThrow(/bbox_16/);
  });

  it('rejects a non-float output rather than decoding garbage', async () => {
    const { session } = fakeSession({ badType: 'cls_8' });
    await expect(
      backendWith(session).infer({ rgba: image(), inputSize: 640, scale: 1, pad: NO_PAD }),
    ).rejects.toThrow(/cls_8/);
  });

  it('refuses to infer after dispose', async () => {
    const { session } = fakeSession();
    const b = backendWith(session);
    await b.dispose();
    await expect(
      b.infer({ rgba: image(), inputSize: 640, scale: 1, pad: NO_PAD }),
    ).rejects.toThrow(/dispose/);
  });

  it('releases the session on dispose, exactly once', async () => {
    let released = 0;
    const { session } = fakeSession();
    const withRelease: OrtSessionLike = {
      ...session,
      release: () => {
        released += 1;
        return Promise.resolve();
      },
    };
    const b = backendWith(withRelease);
    await b.dispose();
    await b.dispose();
    expect(released).toBe(1);
  });
});

describe('createYunetBackend', () => {
  it('measures weightBytes from the bytes actually loaded', async () => {
    // Declared sizes drift, and this feeds the resource metric at 20% of the
    // score. Measured or not trusted.
    const b = await createYunetBackend({
      config: CONFIG,
      api,
      fetchWeights: () => Promise.resolve(new Uint8Array(232_589)),
    });
    expect(b.weightBytes).toBe(232_589);
    expect(b.inputSize).toBe(640);
    expect(b.modelId).toBe('opencv/face_detection_yunet');
  });

  it('refuses empty weights instead of loading a model that finds nothing', async () => {
    await expect(
      createYunetBackend({
        config: CONFIG,
        api,
        fetchWeights: () => Promise.resolve(new Uint8Array(0)),
      }),
    ).rejects.toThrow(/0 bytes/);
  });

  it('names the model in a load timeout', async () => {
    await expect(
      createYunetBackend({
        config: { ...CONFIG, timeoutMs: 10 },
        api,
        fetchWeights: () => new Promise(() => {}),
      }),
    ).rejects.toThrow(/face_detection_yunet/);
  });

  it('asks for webgpu first only when it was requested', () => {
    expect(yunetProviders('webgpu')).toEqual(['webgpu', 'wasm']);
    expect(yunetProviders('wasm')).toEqual(['wasm']);
  });
});
