/**
 * ref/core/winpath.js — Windows 路径超链接辅助（复刻 Purchase Order Extractor V2 core/winpath.py）
 *
 * 逆向来源：tools/poe-reverse/dis/core/winpath.txt（288 行反汇编，逐字节码还原）
 *
 * 用途：为 Excel 模板 B 的 Y 列（源文件超链接）生成可靠的 file:// URI。
 * 原版动机：Excel 对长路径 / Unicode / 空格 / '#'（被 Excel 当作 sheet 锚点）处理脆弱，
 * 优先使用 Windows 8.3 短名（纯 ASCII、无空格、够短）。
 *
 * JS 移植说明（与 Python 唯一行为差异）：
 *  - 原版在 Windows 上经 ctypes 调 kernel32.GetShortPathNameW 取 8.3 短名；
 *    本模块为纯 Node 实现、无原生绑定，_get_short_path 在 win32 上同样返回 null，
 *    调用方自动退回「长路径 + 空格 %20 编码」分支——与 oracle 采样（路径不存在）
 *    完全一致；仅「Windows 真实存在的长路径文件」场景有超链接外观差异，数据无影响。
 */

const fs = require('fs');

/**
 * Windows 8.3 短路径（原版 ctypes GetShortPathNameW）。
 * 非 win32 / 路径为空 / 文件不存在 / 调用失败 → null。
 * @param {string} long_path
 * @returns {string|null}
 */
function _get_short_path(long_path) {
  if (!long_path || process.platform !== 'win32') return null;
  try {
    // GetShortPathNameW 对不存在的文件返回 0 → 原版返回 None；JS 侧等价判定。
    if (!fs.existsSync(long_path)) return null;
    // 无原生 8.3 短名绑定 → 恒 null（见文件头移植说明）。
    return null;
  } catch {
    return null;
  }
}

/**
 * 构造 Excel 可用的 file:// URL。
 * 空路径 → ''；路径存在且拿到短名 → 用短名；'#' → '%23'；
 * 短名获取失败（falsy）→ 空格 → '%20'（保证 Excel 可点击）。
 * @param {string} full_path
 * @returns {string}
 */
function file_url_for_excel(full_path) {
  if (!full_path) return '';
  let path = full_path;
  if (fs.existsSync(full_path)) {
    const short = _get_short_path(full_path);
    if (short) path = short;
  }
  let url = 'file:///' + String(path).replace(/\\/g, '/');
  url = url.replace(/#/g, '%23');
  if (!_get_short_path(full_path)) {
    url = url.replace(/ /g, '%20');
  }
  return url;
}

/**
 * Excel 超链接公式。label 中的 '"' → '""'（公式字符串转义）；
 * full_path 为空 → 仅返回 label（无链接文本）。
 * @param {string} full_path
 * @param {string} label
 * @returns {string} 例如 =HYPERLINK("file:///C:/a%20b/x.pdf", "x.pdf")
 */
function excel_hyperlink_formula(full_path, label) {
  label = (label || '').replace(/"/g, '""');
  if (!full_path) return label;
  const url = file_url_for_excel(full_path);
  return '=HYPERLINK("' + url + '", "' + label + '")';
}

module.exports = {
  _get_short_path,
  file_url_for_excel,
  excel_hyperlink_formula,
};
