// Relaydesk：把上游的订单批次导入本地。连接不稳定是常态，所以重试路径决定了会不会出现重复订单。

/** 上游客户端：send(batch) 要么返回回执，要么因为超时抛错。 */
export async function importOrders(client, orders, makeBatchId) {
  const batchId = makeBatchId();
  try {
    return await client.send({ batchId, orders });
  } catch (error) {
    if (error.code !== 'ETIMEDOUT') throw error;
    // 补丁 1：重试沿用同一个批次号。上游按批次号幂等，丢失的只是应答，不是订单，
    // 所以重发同一批不会再记第二次。
    return client.send({ batchId, orders, retryOf: batchId });
  }
}
