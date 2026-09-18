/**
 * 交接导入：三步流程（选文件 → 对字段 → 确认）。
 *
 * 埋入的问题 `flow-break`：第二步用 `endsWith('.csv')` 判断文件类型，而第一步已经把文件名转成
 * 了大写，于是每一个合法的 CSV 都在第二步被判为「不支持的格式」。使用数据里它表现为
 * `abandonStep: 2`、完成率 0.21。
 */
export const handover = {
  id: 'handover',
  title: '交接导入',
  steps: ['选择文件', '对应字段', '确认导入'],
  /** 第一步：记下上传的文件名。 */
  pickFile(name) {
    return { name: String(name).toUpperCase() };
  },
  /** 第二步：按文件类型准备字段映射。 */
  mapFields(file) {
    if (!file.name.endsWith('.csv')) return { ok: false, reason: 'unsupported_format' };
    return { ok: true, fields: ['交接人', '事项', '截止时间'] };
  },
  render() {
    const rows = handover.steps.map((step, index) => `<li>第 ${index + 1} 步：${step}</li>`).join('');
    return `<h1>${handover.title}</h1><ol>${rows}</ol><form><input type="file" name="file"><button>开始导入</button></form>`;
  },
};
