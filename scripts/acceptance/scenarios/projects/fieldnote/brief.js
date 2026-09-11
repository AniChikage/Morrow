// Fieldnote：把使用者自己的材料整理成一份可交付的简报。
// v1 不管材料够不够，也不告诉使用者结论是从哪条材料来的。

/** 一份材料：{ id, text }。 */
export function buildBrief(notes) {
  const usable = notes.filter((note) => note.text.trim());
  return {
    sections: usable.map((note) => ({ title: note.text.trim().slice(0, 24), body: note.text.trim() })),
    count: usable.length,
  };
}
