import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * `normal` answers every request; `disconnect` records a release upload and then drops the socket;
 * `wrong` answers an upload with a receipt whose artifact hash does not match; `unavailable` answers
 * everything with 503 (the body is still sent).
 */
export type ReceiverMode = 'normal' | 'disconnect' | 'wrong' | 'unavailable';
export type Receiver = {
  /** Origin of the receiver, e.g. `http://127.0.0.1:54321`; append the path a scenario needs. */
  url: string;
  /** Release uploads received, including ones answered in a failure mode. */
  readonly posts: number;
  /** Decoded artifact of the latest upload. */
  readonly uploaded: string;
  /** Receipt of the latest upload, as `GET /status` reports it. */
  readonly receipt: any;
  /** Replaces the feedback sample: a value, or a function read on every request. */
  setFeedback(feedback: unknown): void;
  setMode(mode: ReceiverMode): void;
  close(): Promise<void>;
};

/**
 * A local HTTP endpoint standing in for the outside world: `GET /status` (with any query, as the
 * release reconciliation adds `releaseId`) returns the latest release receipt, every other GET returns
 * the current feedback sample, and a POST records a release upload
 * (verifying the artifact hash) and answers with its receipt. No request leaves this machine.
 */
export async function startReceiver(options: { feedback?: unknown } = {}): Promise<Receiver> {
  let feedback: unknown = options.feedback;
  let receipt: any = {};
  let posts = 0;
  let uploaded = '';
  let mode: ReceiverMode = 'normal';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'unavailable') res.statusCode = 503;
    if (req.method === 'POST') {
      posts++;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const data = JSON.parse(raw);
      uploaded = Buffer.from(data.artifact.base64, 'base64').toString('utf8');
      assert.equal(createHash('sha256').update(uploaded).digest('hex'), data.artifact.sha256);
      receipt = { releaseId: data.releaseId, artifactSha256: data.artifact.sha256, status: 'published' };
      if (mode === 'disconnect') {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify(mode === 'wrong' ? { ...receipt, artifactSha256: 'wrong' } : receipt));
      return;
    }
    const sample = typeof feedback === 'function' ? (feedback as () => unknown)() : feedback;
    const status = new URL(req.url || '/', 'http://127.0.0.1').pathname === '/status';
    res.end(JSON.stringify(status ? receipt : sample));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get posts() {
      return posts;
    },
    get uploaded() {
      return uploaded;
    },
    get receipt() {
      return receipt;
    },
    setFeedback: (value) => {
      feedback = value;
    },
    setMode: (value) => {
      mode = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
