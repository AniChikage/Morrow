// Relaydesk：把上游的订单批次导入本地。连接不稳定是常态，所以重试路径决定了会不会出现重复订单。

/** 上游客户端：send(batch) 要么返回回执，要么因为超时抛错。 */
export async function importOrders(client, orders, makeBatchId) {
  const batchId = makeBatchId();
  try {
    return await client.send({ batchId, orders });
  } catch (error) {
    if (error.code !== 'ETIMEDOUT') throw error;
    // v1：超时后换一个新批次号重发。上游其实已经收下了第一批，于是同一批订单被记两次。
    return client.send({ batchId: makeBatchId(), orders });
  }
}
