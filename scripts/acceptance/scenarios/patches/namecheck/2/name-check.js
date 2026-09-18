// 首次使用时给团队起一个名字。整条首次使用流程只在这里校验一次，所以这一个函数决定了
// 有多少人能走完首次使用。
const LIMIT = 32;

/**
 * 补丁 2：把 Unicode Mark 类别一起接受。天城文等书写系统里的元音符号属于 \p{M}，
 * 只放行 \p{L} 与 \p{N} 会把「टीम」这种正常名字判成非法字符。
 */
export function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, reason: 'blank' };
  if ([...name].length > LIMIT) return { ok: false, reason: 'too_long' };
  if (!/^[\p{L}\p{M}\p{N} -]+$/u.test(name)) return { ok: false, reason: 'unsupported_characters' };
  return { ok: true, name };
}
