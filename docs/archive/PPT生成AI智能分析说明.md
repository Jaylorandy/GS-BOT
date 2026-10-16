# PPT生成功能 - AI智能分析说明

## 🤖 AI智能分析功能概述

当你在PPT制作器中启用"Ollama AI智能解析"后，系统会使用AI模型来**补充**产品信息文件（TXT/RTF）中缺失的内容。

---

## 📋 分析内容

### 1. **触发条件**
AI智能解析**仅在以下情况触发**：
```python
if OLLAMA_ENABLED and (not name or not composition):
    # 触发AI解析
```

**触发场景：**
- ✅ 产品名称（name）为空
- ✅ 面料成分（composition）为空
- ❌ 如果两者都有内容，**不会触发AI解析**

### 2. **分析的字段**

AI会尝试从文本中提取以下信息：

| 字段 | 说明 | 示例 |
|------|------|------|
| **styleNumber** | 款号 | `032GK-90M` |
| **name** | 产品名称 | `Cargo pants` |
| **color** | 颜色 | `Grey`, `dark grey` |
| **price** | 价格 | `ALL 3,899` |
| **description** | 产品描述 | `Loose-fit trousers...` |
| **composition** | 面料成分 | `100% Cotton` |

### 3. **补充逻辑**

AI解析结果会**智能补充**，而不是覆盖：

```python
# 只有当基础解析为空时，才使用AI结果
if ollama_result.get('name') and not result['name']:
    result['name'] = ollama_result['name']  # 补充产品名称

if ollama_result.get('composition') and not result['composition']:
    result['composition'] = ollama_result['composition']  # 补充面料

if ollama_result.get('color') and not result['colorRef']:
    result['colorRef'] = ollama_result['color']  # 补充颜色
```

**优先级：**
1. 🥇 **基础解析结果**（正则表达式提取）
2. 🥈 **AI补充结果**（仅在基础解析为空时使用）

---

## 🔍 实际工作流程

### 场景1：完整的产品信息文件
```
文件: ZARA/1538451711/1538451711.txt

POCKET OVERSHIRT
59.90 USD
Sand
Relaxed fit overshirt made with cotton
100% Cotton
```

**处理过程：**
1. ✅ 基础解析成功提取：
   - 产品名称: `POCKET OVERSHIRT`
   - 价格: `59.90 USD`
   - 颜色: `Sand`
   - 描述: `Relaxed fit overshirt made with cotton`
   - 面料: `100% Cotton`

2. ❌ **不触发AI解析**（因为name和composition都有值）

**结果：** 使用基础解析结果，AI不参与

---

### 场景2：缺少产品名称
```
文件: LPP/032GK-90M/032GK-90M.rtf

ALL 3,899
Grey
Outer Shell: 100% Cotton
```

**处理过程：**
1. ⚠️ 基础解析：
   - 产品名称: ❌ **为空**
   - 价格: `ALL 3,899`
   - 颜色: `Grey`
   - 面料: `100% Cotton`

2. ✅ **触发AI解析**（因为name为空）

3. AI提示词：
```
Extract product info from text. Return JSON only:
{
  "styleNumber": "use folder name if not found: 032GK-90M",
  "name": "product name",
  "color": "color",
  "price": "",
  "description": "short description",
  "composition": "fabric composition"
}

Text:
ALL 3,899
Grey
Outer Shell: 100% Cotton
```

4. AI返回：
```json
{
  "styleNumber": "032GK-90M",
  "name": "Cargo pants",  ← AI推测的产品名
  "color": "Grey",
  "price": "ALL 3,899",
  "description": "",
  "composition": "100% Cotton"
}
```

5. ✅ **补充产品名称**：`Cargo pants`

**结果：** 基础解析 + AI补充 = 完整信息

---

### 场景3：缺少面料成分
```
文件: Reserved/05.03.022.0311/05.03.022.0311.rtf

Cargo pants
ALL 3,899
Grey
```

**处理过程：**
1. ⚠️ 基础解析：
   - 产品名称: `Cargo pants`
   - 价格: `ALL 3,899`
   - 颜色: `Grey`
   - 面料: ❌ **为空**

2. ✅ **触发AI解析**（因为composition为空）

3. AI尝试从文本推测面料成分

4. ⚠️ **AI可能无法推测**（因为文本中没有面料信息）

**结果：** 面料字段仍然为空（AI也无法凭空创造）

---

## ⚙️ 配置参数

### 前端配置
在Slides Maker模块中：
```javascript
{
  ollamaEnabled: true,              // 启用AI解析
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "qwen3-vl:8b"
}
```

### Python脚本参数
```python
OLLAMA_ENABLED = True              # 由前端配置覆盖
OLLAMA_TIMEOUT = 15                # 超时时间（秒）
OLLAMA_MODEL = "qwen3-vl:8b"       # 模型名称
OLLAMA_URL = "http://localhost:11434"
```

---

## 📊 性能影响

### 不启用AI（默认）
- ⚡ **速度快**：纯正则表达式解析
- 💾 **资源少**：不需要运行AI模型
- ✅ **适用场景**：产品信息文件完整

### 启用AI
- 🐌 **速度慢**：每个产品需要15秒超时等待
- 💻 **资源多**：需要运行Ollama服务
- ✅ **适用场景**：产品信息文件不完整，需要AI推测

**示例：**
- 10个产品，不启用AI：**~5秒**
- 10个产品，启用AI（全部触发）：**~150秒**（2.5分钟）

---

## 🎯 最佳实践

### 1. **什么时候启用AI？**
✅ **建议启用：**
- 产品信息文件不完整
- 缺少产品名称或面料信息
- 需要AI推测补充

❌ **不建议启用：**
- 产品信息文件完整
- 追求生成速度
- 没有安装Ollama

### 2. **如何提高AI准确性？**
- ✅ 使用更强大的模型（如 `qwen2.5:14b`）
- ✅ 在文本文件中提供更多上下文
- ✅ 使用结构化的文本格式

### 3. **如何检查AI是否工作？**
查看应用日志窗口：
```
[1/10] 1538451711
  尝试使用Ollama智能解析...        ← AI触发
  Ollama补充产品名称: Cargo pants  ← AI成功
  Ollama补充面料成分               ← AI成功
```

---

## 🔧 故障排查

### 问题1：AI没有触发
**原因：** 产品名称和面料成分都有值
**解决：** 这是正常的，不需要AI补充

### 问题2：AI超时
```
Ollama timeout (15s)
```
**原因：** 模型响应太慢
**解决：** 
- 增加超时时间（修改 `OLLAMA_TIMEOUT`）
- 使用更小的模型（如 `qwen2.5:3b`）

### 问题3：AI返回空结果
```
Ollama解析失败或未返回结果
```
**原因：** 
- Ollama服务未运行
- 模型不存在
- 文本内容太少

**解决：**
- 检查Ollama服务：`ollama list`
- 确保模型已下载：`ollama pull qwen3-vl:8b`

---

## 📝 总结

**AI智能解析的作用：**
- 🎯 **补充**缺失的产品信息
- 🚫 **不会覆盖**已有的信息
- ⚡ **按需触发**，不是每个产品都会使用
- 🤖 **智能推测**，但不保证100%准确

**推荐使用场景：**
- 产品信息不完整
- 需要批量处理大量产品
- 愿意等待AI处理时间

**不推荐使用场景：**
- 产品信息已完整
- 追求快速生成
- 没有AI模型支持

---

**更新时间**: 2026年3月19日  
**版本**: GS Bot 1.0.0
