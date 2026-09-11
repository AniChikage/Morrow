// ParcelNotes：把交接记录导出成一份交接包。导出后还要回头翻原文，说明这份包没带够信息。

const LIMIT = 80;

/** 一条交接记录：{ id, title, body }。 */
export function exportHandoff(records) {
  return {
    count: records.length,
    // v1：正文按 80 字截断。条数没变，所以只数条数的检查一直是通过的。
    items: records.map((record) => ({ id: record.id, title: record.title, body: record.body.slice(0, LIMIT) })),
  };
}
