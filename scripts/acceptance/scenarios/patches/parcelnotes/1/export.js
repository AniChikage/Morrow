// ParcelNotes：把交接记录导出成一份交接包。导出后还要回头翻原文，说明这份包没带够信息。

/** 一条交接记录：{ id, title, body }。 */
export function exportHandoff(records) {
  return {
    count: records.length,
    // 补丁 1：去掉正文截断。交接要求经常写在正文末尾，截断会把它整段丢掉，
    // 而只数条数的检查看不出这种损失。
    items: records.map((record) => ({ id: record.id, title: record.title, body: record.body })),
  };
}
