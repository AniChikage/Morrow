// Fieldnote：把使用者自己的材料整理成一份可交付的简报。
// 补丁 1：先做材料就绪检查——材料不够时说清缺什么，而不是生成一份看起来完整的简报。

const required = ['背景', '结论'];

/** 一份材料：{ id, text, kind }。 */
export function buildBrief(notes) {
  const usable = notes.filter((note) => note.text.trim());
  const missing = required.filter((kind) => !usable.some((note) => note.kind === kind));
  if (missing.length) return { ready: false, missing, sections: [], count: 0 };
  return {
    ready: true,
    missing: [],
    sections: usable.map((note) => ({ title: note.text.trim().slice(0, 24), body: note.text.trim() })),
    count: usable.length,
  };
}
