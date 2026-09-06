import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in agent server that INSPECTS what it is given.
 *
 * WHY THIS EXISTS RATHER THAN A `fetchImpl` STUB. An injected fetch proves the
 * client calls a function. It does not prove what actually goes on the wire: a
 * stub sees the object the client passed, not the bytes `JSON.stringify` and the
 * HTTP layer produced, and it sees them in the same process with the same heap.
 * Every leak this project fears is a leak of BYTES - a value that survived
 * serialisation - so the check has to happen on the far side of a real socket.
 *
 * It is also the only honest way to test the three off-device deployments. Local,
 * private and cloud differ by endpoint and by token; a real listener can be
 * pointed at from all three and can assert the requests are identical.
 *
 * NO REAL CREDENTIAL, EVER. It generates its own token when one is wanted, so
 * `npm test` needs no API key and no network. That is a hard requirement: a test
 * suite that only passes for somebody holding a key is a test suite most people
 * cannot run.
 *
 * `tests/` is where this lives because `node:*` is forbidden inside `src/` and
 * `boundaries.test.ts` enforces it.
 */

/** A request as it actually arrived, before anything interprets it. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** The RAW body text. Every leak assertion greps this, not a parsed object. */
  readonly rawBody: string;
  /**
   * Headers, lower-cased.
   *
   * Kept so a test can assert a token arrived HERE and not in `rawBody` - the
   * whole point of putting it in a header being that the body is what gets
   * logged, cached and forwarded.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly parsed: unknown;
}

export interface MockBackendOptions {
  /**
   * Raw model output, one per request, in order. Exhausting it yields `done`.
   *
   * A raw STRING and not an `Action`, because that is what the protocol carries
   * and what the client must parse and validate. A mock that returned a typed
   * action would quietly skip the two checks that make trusting a server
   * unnecessary.
   */
  readonly script?: readonly string[];
  /** Require this bearer token. Null (the default) accepts anything. */
  readonly authToken?: string | null;
  /** Answer every /plan with this status instead of planning. For failure tests. */
  readonly failWith?: number;
  readonly modelId?: string;
  /** Reported on /health. Lets a test assert the panel shows a MEASURED value. */
  readonly plannerId?: string;
}

export interface MockBackend {
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  /** Every /plan body, concatenated. What the leak assertions grep. */
  bodyText(): string;
  close(): Promise<void>;
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startMockBackend(options: MockBackendOptions = {}): Promise<MockBackend> {
  const recorded: RecordedRequest[] = [];
  const script = options.script ?? [];
  const modelId = options.modelId ?? 'mock-vlm';
  const authToken = options.authToken ?? null;
  let planCalls = 0;

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const rawBody = req.method === 'POST' ? await readBody(req) : '';
      let parsed: unknown = null;
      try {
        parsed = rawBody === '' ? null : (JSON.parse(rawBody) as unknown);
      } catch {
        parsed = null;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      recorded.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        rawBody,
        headers,
        parsed,
      });

      if (req.url === '/health') {
        send(res, 200, {
          ok: true,
          planner: options.plannerId ?? modelId,
          description: `mock backend (${modelId})`,
          prompt: 'mock0000',
          auth: authToken !== null,
        });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/plan') {
        send(res, 404, { error: 'POST /plan' });
        return;
      }

      if (authToken !== null && bearerOf(req) !== authToken) {
        send(res, 401, {
          ok: false,
          error: { protocolVersion: 1, error: 'unauthorized', retryable: false },
        });
        return;
      }

      if (options.failWith !== undefined) {
        send(res, options.failWith, {
          ok: false,
          error: { protocolVersion: 1, error: 'mock failure', retryable: true },
        });
        return;
      }

      const raw = script[planCalls] ?? '{"type":"done","summary":"script exhausted"}';
      planCalls += 1;
      send(res, 200, {
        ok: true,
        response: { protocolVersion: 1, raw, modelId, serverMs: 1 },
      });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests: recorded,
    bodyText: () =>
      recorded
        .filter((r) => r.url === '/plan')
        .map((r) => r.rawBody)
        .join('\n'),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * A base64 run long enough that it can only be image bytes.
 *
 * Used to assert a RAW screenshot never appears in a body. A redacted one does
 * appear - legitimately, that is the deliverable - so the test that uses this
 * checks the payload against the RAW frame's own base64, not against "is there
 * an image here". Matching on shape alone would flag the correct case.
 */
export function containsBase64Blob(body: string, needle: string, minChars = 64): boolean {
  if (needle.length < minChars) return false;
  return body.includes(needle.slice(0, Math.max(minChars, Math.floor(needle.length / 2))));
}
