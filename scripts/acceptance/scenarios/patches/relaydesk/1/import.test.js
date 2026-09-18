import test from 'node:test';
import assert from 'node:assert/strict';
import { importOrders } from './import.js';

const ids = () => {
  let n = 0;
  return () => `batch-${++n}`;
};

test('正常返回时只发一次', async () => {
  const sent = [];
  const client = { send: async (payload) => (sent.push(payload), { batchId: payload.batchId, accepted: 1 }) };
  await importOrders(client, [{ id: 'o1' }], ids());
  assert.equal(sent.length, 1);
});

test('应答丢失后重试沿用同一个批次号', async () => {
  const sent = [];
  const client = {
    send: async (payload) => {
      sent.push(payload);
      if (sent.length === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return { batchId: payload.batchId, accepted: 1 };
    },
  };
  await importOrders(client, [{ id: 'o1' }], ids());
  assert.deepEqual(
    sent.map((payload) => payload.batchId),
    ['batch-1', 'batch-1']
  );
});
