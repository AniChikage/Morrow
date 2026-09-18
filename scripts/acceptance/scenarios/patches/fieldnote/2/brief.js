// Fieldnote：把使用者自己的材料整理成一份可交付的简报。
// 补丁 1：材料就绪检查。
// 补丁 2：每一节都带上它来自哪条材料，交付前再做一次证据审计——引用不到原文的结论不算可交付。

const required = ['背景', '结论'];

/** 一份材料：{ id, text, kind }。 */
export function buildBrief(notes) {
  const usable = notes.filter((note) => note.text.trim());
  const missing = required.filter((kind) => !usable.some((note) => note.kind === kind));
  if (missing.length) return { ready: false, missing, sections: [], count: 0 };
  const sections = usable.map((note) => ({
    title: note.text.trim().slice(0, 24),
    body: note.text.trim(),
    source: note.id,
  }));
  return { ready: true, missing: [], sections, count: sections.length };
}

/** 交付前的证据审计：每一节都要能回到一条真实材料，否则这份简报不能交付。 */
export function auditBrief(brief, notes) {
  const unsourced = brief.sections.filter((section) => !notes.some((note) => note.id === section.source));
  return { deliverable: unsourced.length === 0, unsourced: unsourced.map((section) => section.title) };
}
