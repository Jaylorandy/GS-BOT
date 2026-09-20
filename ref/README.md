# ref/ — Purchase Order Extractor V2 复刻落地（阶段一）

> 本目录是「Purchase Order Extractor V2」独立程序（`C:\Program Files\Purchase Order Extractor V2`, V2.0.19.39, PyInstaller+Py3.11）的 **Node.js 复刻落地**。
> 完整逆向规格见 `E:\GS Bot-app\复刻分析\复刻方案.md`（方法论：AI 读数据、代码写规则、离线回放门禁）。
> 落地目标：在 GS Bot（Electron）内复刻其指纹缓存 + 结构化解析能力，解决 GS Bot 对多色 PO 只出 1 色、矩阵版式数量错乱的问题。

---

## 1. 当前进度（2026-09-04）

| 模块 | 状态 | 说明 |
|---|---|---|
| `core/cache.js` | ✅ 完成 | 指纹算法（skeleton/折叠/markers/SHA256），`test_cache.js` 对照 `oracle_cache.json` 通过 |
| `core/normalize.js` | ✅ 完成 | 归一管线 + 词表，`test_normalize.js` 对照 `oracle_normalize.json` 通过 |
| `core/winpath.js` | ✅ 完成 | 路径工具（HYPERLINK 公式等） |
| `core/models.js` | ✅ 完成 | 数据契约（PurchaseOrder/OrderEntity/OrderLine/SizeQty/PoRecipe 58 字段 + recipes 应用 + Python 风格 to_json）。`test_models.js` 对照 `oracle_models.json`/`oracle_models_extra.json`/`probe_oracle.json` **292 项断言全过** |
| `core/parsers/base.js` | ✅ 完成 | 公共基类：Token/PageWords/BaseParser + 30+ 工具函数（_to_int/_to_float/_looks_like_style/_looks_like_sku/norm_date/extract_color_from_combined/merge_wrapped_rows/size_columns/split_row_total/parse_total_row/is_size_header 等）。`test_parsers.js` 对照 `oracle_parsers.json` **全量断言通过** |
| `core/parsers/line_items.js` | ✅ 完成 | 行式明细解析器（LineItemsParser extends BaseParser）：line_pattern 逐行匹配、entity_anchor 提取 PO 号、TJX ratio/units 尺码编码、颜色描述提取、重复行去重。`test_parsers.js` 对照 `oracle_parsers.json` **全量断言通过** |
| 阶段二 recipe_synth | ⏳ 未开始 | locate_samples / assign_roles / synthesize_line_pattern / verify_recipe / acquire_recipe |
| 阶段三~五 | ⏳ 未开始 | matrix_synth / export_gate / 客户 parser / AI 桥 / 回灌 / GS Bot 集成 |

## 2. oracle 测试基建（关键！必须用 py311 跑）

```bash
PY311="C:/Users/Administrator/.workbuddy/binaries/python/pyinstxtractor_tool/py311/python.exe"
cd "E:/GS Bot-app/ref/test" && "$PY311" oracle_models.py          # → oracle_models.json
cd "E:/GS Bot-app/ref/test" && "$PY311" oracle_models_extra.py    # → oracle_models_extra.json
cd "E:/GS Bot-app/ref/test" && "$PY311" probe_oracle.py           # → probe_oracle.json
```

- **为什么必须 py311**：`models.pyc` 是 3.11 字节码，用 3.13/3.14 运行会 **segfault**（稳定复现，非偶发）。
- **winpath_stub.py**：原版 `core.winpath.pyc` 需 pywin32（本机缺失 → segfault），已用行为等价替身注入 `sys.modules`。stub 保真度已验证：`oracle_main_rerun.json` 与原始 `oracle_models.json` **逐字节一致**。
- 所有 oracle 脚本自带 `_quiet_print`，不污染 stdout（stdout 只输出 JSON）。
- pyc 基座：`C:\Users\Administrator\.workbuddy\binaries\python\pyinstxtractor_tool\Purchase_Order_Extractor.exe_extracted\PYZ.pyz_extracted\core\models.pyc`

## 3. models.js 数据契约（oracle 已确认，直接照此实现）

### 3.1 类结构
```
PurchaseOrder { customer, source_file, source_file_path, order_date, per_destination,
                fingerprint, entities[], total_qty(计算属性) }
OrderEntity   { entity_index, po_no, channel, season, delivery_date, destination_code,
                packing_method, wash_method, washing_color, payment_terms, price_term,
                currency, size_scale, product_group, age_sex_desc, product_desc,
                port_loading, port_discharge, ship_mode, vendor_name, agent_name,
                import_po_no, reference_no, cir_no, freight_terms, country_of_origin,
                dc_address, lines[], printed_size_totals, printed_total_qty,
                printed_total_amount, extra }
OrderLine     { style_no, color_code, color_desc, inseam, su, unit_price,
                printed_row_total, net_amount, sizes[] }
SizeQty       { size, qty, qty_safe(计算) }
```

### 3.2 apply_recipe_overrides（配方覆盖，oracle A–I + probe P1–P4 确认）
- **全局键**（直接作用于实体/全部行）：
  - `unit_price`：**剥离所有逗号 → float**，失败 → `null`。`'12,50'→1250.0`、`'10,5,5'→1055.0`、`'10'→10.0`、`'abc'→null`。⚠️ 与方案.md §7 的「欧式数字」AI prompt 规则（点=千分位、逗号=小数）**不同**——models 层是纯剥离逗号，以 oracle 为准。
  - `su`：**空串也传播**（`''→''` 覆盖原值），`'PAIR'` 同理。
  - 表头 26 键（上述 25 键 + `currency`）直接覆盖实体字段。
- **`__line_overrides__`**（行级，键匹配优先级 **与 dict 顺序无关**）：
  - 优先级：**combined `'90Z / BLACK'` > 带␟ `'90Z / BLACK␟30'` > code-only `'90Z'`**（probe P2 / oracle H 双向验证）。
  - `sizes` **合并语义**：只更新**已存在**的尺寸键，**不新增**；override 未提及的现有尺寸**保留**。例：原 `[S:200, L:'abc']` + `{S:'250', M:'3,000'}` → `[S:250, L:'abc']`（M 被丢弃，L 保留）。
  - sizes 数量解析：`int(float(x))` 截断——`'3,000'→3000`、`'12,5'→125`、`'5.7'→5`、无法解析（如 `'x'`）→ **保留原值**。
  - `inseam`/`su` 等直接覆盖。
- **`__ent_overrides__`**：键为**字符串形式的 entity_index**（`'1'` → entities[1]）。
- **`color_edits`**：非法 JSON 串**静默忽略**（不抛异常）；`'null'` 合法 → 无编辑，`_cleanable_pairs()` 返回全部 `H1·字段` / `L1-N·字段` 对。

### 3.3 apply_field_defaults（oracle E）
- **覆盖语义（非只填空）**：`field_defaults: {style_no:'X1', su:'PAIR', customer:'NEW CUST', po_no:'P9'}` → 行级 style_no/su **连非空值也覆盖**（`PCS→PAIR`），po_no/customer 同。
- `changes` 返回数组，格式 `"H1·po_no: '11321589' → 'P9' (默认)"`、`"L1-1·款式: '637JO' → 'X1' (默认)"`；注意 su 应用了但**可能不进 changes**（以 oracle E 输出为准）。

### 3.4 SizeQty.qty_safe（oracle G）
- `strip() → int()`，失败 → `0`。`' 5 '→5`、`True→1`、`'-3'→-3`、`''→0`、`'0'→0`、`'5.7'→0`。
- ⚠️ 与 override sizes 解析（int(float()) 截断）**是两条不同路径**，勿混用。

### 3.5 total_qty
- Σ 各行 sizes 的 qty_safe（`'abc'` 计 0）。例：`[S:744,M:500] + [S:250,L:'abc'] = 1494`。

### 3.6 其他（oracle_models.json 主契约）
- `clean_field_*`：style/unknown/color_desc/color_code_only/color_split 五组清洗行为。
- `to_json` / `from_json`：roundtrip 保真；`from_json_legacy` 接受旧字段名。
- 均以 `ref/test/oracle_models.json` 为断言基准。

## 4. 下一步（按顺序）

1. 阶段二：`recipe_synth`（素材 `core__recipe_synth.txt` + 4932 行反汇编）。
2. 阶段三~五见复刻方案.md §14。

## 5. 任务列表遗留说明
- 当前真正 in_progress：无——parsers/base.js + line_items.js 及测试已完成收尾（2026-09-04）。
- `#36 zip 补丁写回`、`#48 模板合规校验`、`#64 测试更新与全量回归` 等为 GS Bot 主项目遗留，与复刻落地互不阻塞。

## 6. 关键文件索引
| 用途 | 路径 |
|---|---|
| 复刻完整规格 | `E:\GS Bot-app\复刻分析\复刻方案.md` |
| 素材 dump（49 模块字符串） | `E:\GS Bot-app\复刻分析\core__*.txt` 等 |
| 反汇编（cache 3370 行 / recipe_synth 4932 行） | `复刻分析\core__store__cache__dis.txt` / `core__recipe_synth__core_dis.txt` |
| 模板解析 | `复刻分析\template_analysis\*.json` |
| models 契约 oracle | `ref\test\oracle_models.json` / `oracle_models_extra.json` / `probe_oracle.json` |
| parsers 行为 oracle | `ref\test\oracle_parsers.json` / `probe_parsers*.json` |
| oracle 运行环境 | `ref\test\pyc_loader.py` / `winpath_stub.py` |
| 已落地 JS | `ref\core\cache.js` / `normalize.js` / `winpath.js` / `models.js` / `parsers\base.js` / `parsers\line_items.js` |
| 已过测试 | `ref\test\test_cache.js` / `test_normalize.js` / `test_models.js`（312 项断言）/ `test_parsers.js` |
