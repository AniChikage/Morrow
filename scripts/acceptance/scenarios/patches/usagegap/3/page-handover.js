/**
 * 交接导入：三步流程（选文件 → 对字段 → 确认）。
 *
 * 补丁 3 修掉 `flow-break`：第二步不再对已经被转成大写的文件名做大小写敏感的后缀判断，合法的
 * CSV 不会再在第二步被判成「不支持的格式」。第一步的行为保持不变，只是判断方式改成大小写无关。
 */
export const handover = {
  id: 'handover',
  title: '交接导入',
  steps: ['选择文件', '对应字段', '确认导入'],
  /** 第一步：记下上传的文件名。 */
  pickFile(name) {
    return { name: String(name).toUpperCase() };
  },
  /** 第二步：按文件类型准备字段映射，后缀判断与大小写无关。 */
  mapFields(file) {
    if (!/\.csv$/i.test(file.name)) return { ok: false, reason: 'unsupported_format' };
    return { ok: true, fields: ['交接人', '事项', '截止时间'] };
  },
  render() {
    const rows = handover.steps.map((step, index) => `<li>第 ${index + 1} 步：${step}</li>`).join('');
    return `<h1>${handover.title}</h1><ol>${rows}</ol><form><input type="file" name="file"><button>开始导入</button></form>`;
  },
};
