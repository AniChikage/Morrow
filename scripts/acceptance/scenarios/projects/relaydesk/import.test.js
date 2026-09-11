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
