# 规格：抓取浏览器改为「本地浏览器优先」

> 状态：**阶段 1 已实施 + 阶段 2 前置修复已完成**（本机实测进行中；阶段 3 打包待做）
> 目标版本：v2.2.0（行为变更 + 体积减少，走 minor）
> 关联：《踩坑日志.md》「需求：改用本地浏览器…可行性评估」节

---

## 0. 已确认的决策

| 项 | 决策 |
|---|---|
| 解析优先级 | **Chrome → Edge → 报错**（不再有内置 Chromium 夹层） |
| 找不到时的行为 | **直接报错**，提示用户安装 Chrome / Edge（不是 app 自己下载） |
| macOS | **要求本机 Google Chrome**；缺失即提示安装 Chrome（不做 Safari） |
| 内置 Chromium | **彻底删除**：设置项 + 解析分支 + 打包产物（407 MB） |
| 本轮范围 | 只出规格文档；**不改代码** |

---

## 1. 实测调用面（决定了改动量）

`main.js` 共 **15 个 `puppeteer.launch()`**，`executablePath` 来源高度统一：

| 入口 | 站点数量 | 位置 |
|---|---|---|
| `findChromePath()` → `runtimeResolver.findChromeExecutable()` | **13** | main.js:3474 / 3904 / 4576 / 8686 / 9038 / 9621 / 10855 / 12217 / 14532 / 14808 / 15735 / 16688 / 20266 |
| `resolveScraperBrowserExecutable()` | **2** | main.js:17428（H&M 单品）、main.js:19263（Bestseller，含 `config.scraperBrowser`） |
| 其它 | 0 | — |

**⇒ 关键结论：13 个站点共享一个入口函数，改 1 处即可全部覆盖。**

其余被引用的解析函数（均需改）：
- `runtime-resolver.js` → `findBrowserExecutable()`（L718）、`findChromeExecutable()`（L853）、`getBundledChromeExecutable()`（L343）、`describeResolvedBrowser()`（L818）
- `main.js` → `findChromePath()`（L21282）、`resolveScraperBrowserExecutable()`（L1596）、`buildHmPreflight()`（L1910）、`describeScraperBrowserStatus()`（L22266）
- `browser-config.js` → `VALID_PREFERENCES`、`normalizePreference()`
- `src/components/SetupGuide.jsx` → `OPTIONS`（L266-287）、状态文案（L352-362）

---

## 2. 改动明细

### 2.1 `runtime-resolver.js`

| 位置 | 改法 |
|---|---|
| `findBrowserExecutable()` L796-808（`auto` 分支） | 重排为 **系统 Chrome → 系统 Edge → `null`**（删掉 `bundled()` 前置） |
| `findBrowserExecutable()` L761-773（`chrome` 分支） | 改为 **Chrome → Edge → `null`**（删掉中间的 `bundled()` 夹层） |
| `findBrowserExecutable()` L774-795（`edge` / `bundled` 分支） | 删 `'bundled'` 分支；`edge` 分支改为 **Edge → Chrome → `null`** |
| `bundled()` 内部 helper（L747-752） | **整体删除** |
| `getBundledChromeExecutable()` L343-354 | **整体删除**（含 `module.exports` 里的引用） |
| `findChromeExecutable()` L853-882 | 删掉两处 win32 `getBundledChromeExecutable()` 分支（L863-865、L876-878）；保留 `getDownloadedChromeExecutable()` 仅在 `preferSystem` 语义下？→ 见 §4 待确认-1 |
| `describeResolvedBrowser()` L824-829 | `brand` 判定去掉 `'chromium'` 兜底；`isBundled` 字段保留但恒为 `false`（前端契约不破坏） |
| 函数头注释 L700-717 | 同步更新优先级说明 |

### 2.2 `browser-config.js`

- `VALID_PREFERENCES`：`['auto','chrome','edge','bundled']` → **`['auto','chrome','edge']`**
- `normalizePreference()`：老配置文件里的 `'bundled'` 会自动 fallback 到 `DEFAULT_PREFERENCE`（`'auto'`）—— 行为安全，无需额外迁移代码，但要在注释里写明
- `DEFAULT_PREFERENCE` 保持 `'auto'`（新语义 = Chrome → Edge）

### 2.3 `main.js`

| 位置 | 改法 |
|---|---|
| `findChromePath()` L21282-21284 | 改为委托 `resolveScraperBrowserExecutable()` —— 这一处让 **13 个站点**同时变成「尊重用户偏好 + 本地浏览器」 |
| `resolveScraperBrowserExecutable()` L1614-1616 | **删掉 `findChromePath()` 兜底**（它会经 `findChromeExecutable()` 把内置放回来）；未解析到直接返回 `null` |
| 14 处 download fallback（`emitLog('⬇️ No local Chrome found…')` + `ensureChromeRuntimeAvailable`） | 替换为统一报错（见 §4 待确认-1） |
| `buildHmPreflight()` L1922-1928 | `bundled-browser` 警告成为死代码 → 删除；保留并强化既有 `no-browser` 错误（L1952-1958） |
| `ensureChromeRuntimeAvailable()` L891-950 | 见 §4 待确认-1（删除 or 保留为设置页手动按钮） |

**报错文案（拟定）**
- Windows：`未找到可用的浏览器。请先安装 Google Chrome 或 Microsoft Edge，或在「设置 → 抓取浏览器」中手动指定浏览器路径。`
- macOS：`未找到 Google Chrome。请先安装 Google Chrome，或在「设置 → 抓取浏览器」中手动指定浏览器路径。`

### 2.4 `src/components/SetupGuide.jsx`

- `OPTIONS` L266-287：删除 `{ value: 'bundled' }` 项
- `auto` 描述：`优先内置 Chromium，其次 Chrome，最后 Edge。` → **`优先本机 Google Chrome，其次 Microsoft Edge。`**（英文同步）
- 状态文案 L352-362：删除 `Bundled Chromium` 分支（`isBundled` 恒 false）
- 组件顶部注释 L251 附近同步

### 2.5 打包（阶段 3 才做）

- `package.json` → `build.win.extraResources`：删除 `{ from: "vendor/windows/chromium", to: "runtime/windows/chromium" }`
- `scripts/prepare-windows-runtime.js`：chromium 准备步骤（L640 附近的 `runtime-manifest.json` 写入）加开关跳过，避免打包前白下载 400 MB
- `scripts/clean-windows-after-pack.js` / asar 完整性补丁：检查是否有 chromium 相关引用
- macOS 侧**无需改动**（`extraResources` 本来只有 `runtime/mac/node`，从来没打过内置 Chromium）

---

## 3. 阶段划分

| 阶段 | 内容 | 风险 | 可回滚 |
|---|---|---|---|
| **1** | 2.1 + 2.2 + 2.3 + 2.4（代码层反转 + 删内置分支 + 报错） | 低 | ✅ 单 commit revert |
| **2** | **本机实测**：Edge 跑一次 H&M bestseller（对照 Chrome 已知成功）；验证手填路径钉版本 | 无（只测不改） | — |
| **3** | 2.5 打包剥离 407 MB + 重新发布 v2.2.0 | 中（打包体积变化） | ✅ 恢复 extraResources 条目 |

---

## 4. 待确认项（已确认）

**[已确认 → 选项 A]** 自动下载兜底（`ensureChromeRuntimeAvailable`）：**删除自动兜底**，15 处调用全部改为报错；函数本体保留，仅挂在设置页的「检查 / 安装浏览器运行时」手动按钮上（新增 IPC `browser-install-chrome-runtime` + preload API + SetupGuide 按钮）。安装成功后自动写入 `chromePath` 并置 `preference: 'chrome'`，使其经「自定义路径」分支被解析。

| 选项 | 含义 | 结论 |
|---|---|---|
| **A（已采用）** | 自动兜底删除，函数保留为设置页手动按钮 | ✅ |
| B | 彻底删除（含函数本体） | ❌ |
| C | 保留自动兜底（Chrome → Edge → 下载 → 报错） | ❌ |

> 注：下载来的 Chrome for Testing **没有用户身份可克隆**，对 H&M 无价值（只能帮到 Zara/UNIQLO 等无身份校验的站点）。

---

## 5. 更正上一轮记录（两处）

1. ❌ 上轮写「**Edge 兜底解决不了 H&M 身份继承**」——**错的**。`findSystemBrowserUserDataDir()`（main.js:1539-1560）**已经**支持 Chrome → Edge 双候选，且**已包含 macOS 路径**（`~/Library/Application Support/Google/Chrome`、`…/Microsoft Edge`）；H&M 身份克隆在 main.js:1747 用的就是它。**R1 风险不存在，已解决。**
2. ❌ 上轮写「main.js 共 **38 处**解析调用点」——**错的**。实测 **15 处 `puppeteer.launch`**，`executablePath` 只由 **2 个入口**（`findChromePath` / `resolveScraperBrowserExecutable`）供给。

---

## 6. 验收标准（阶段 1 完成后）

1. `node node_modules/eslint/bin/eslint.js .` → **0 error**（守卫三件套基线不变：label-naming 31 / vision-preflight 26 / scraper-folders 14）
2. 全局 grep `bundled` 不再出现在浏览器解析路径上（`Bundled Chromium` 文案、`getBundledChromeExecutable`、`preference === 'bundled'` 全清）
3. 老配置 `{"preference":"bundled"}` 加载后 `normalizePreference` → `'auto'`，UI 显示「自动」
4. 本机（已装 Chrome）跑一次非 H&M 抓取 + 一次 H&M bestseller → 均走到系统 Chrome，日志无「下载 Chrome runtime」
5. 手动把 preference 设为 `edge`、Chrome 存在 → 仍优先 Edge（验证偏好生效）
6. 临时把 Chrome/Edge 候选指到不存在路径 → 得到 §2.3 的报错文案，而非崩溃/无限下载

## 7. 回滚

阶段 1 全部改动落在 7 个文件（`main.js` / `runtime-resolver.js` / `browser-config.js` / `preload.js` / `SetupGuide.jsx` / `ModuleHome.jsx` / `wizardConfig.js`），一个 commit 承载 → `git revert` 即恢复。阶段 3 的打包剥离是独立 commit。

---

## 8. 阶段 1 实施记录（2026-10-10 完成）

改动：`browser-config.js` / `runtime-resolver.js` / `main.js` / `preload.js` / `src/ModuleHome.jsx` / `src/components/SetupGuide.jsx` / `src/wizardConfig.js`（7 文件，+237 / −251 行）

| 项 | 实测结果 |
|---|---|
| `node --check` × 4 主进程文件 | 全部 OK |
| `eslint .` | **267 problems (0 errors, 267 warnings)** —— 与基线一致；新增标识符在 lint 输出中**零命中** |
| `auto` | → `system-chrome`（`C:\Users\Administrator\AppData\Local\Google\Chrome\Application\chrome.exe`）|
| `chrome` | → `system-chrome` |
| **`edge`** | → `system-edge`（`msedge.exe`）—— **此前 13 个站点选 Edge 不生效，现已生效** |
| `bundled`（老配置残留） | 不崩、回落 `auto` → `system-chrome`；`browser-config` 会先归一化为 `auto` |
| 不存在的 customPath | 被忽略，落回系统探测（`customPathUsed=false`） |
| `getBundledChromeExecutable` | 已从模块导出中消失（`undefined`） |
| `describeMissingBrowserError` | 1 处定义 / **15 处调用** |
| `ensureChromeRuntimeAvailable` | 2 处出现（= 定义 + 1 个 IPC） |
| 残留 `chromeInstall` / `Downloading Chrome runtime` | **0** |
| `findChromePath()` | 已委托 `resolveScraperBrowserExecutable()`；不再调 `findChromeExecutable` |
| 渲染层 `bundled` / `Bundled Chromium` / `isBundled` | 全部为 `false`（已清干净） |

> 验证方式：`node --check` + **直接 `require` 真实 `runtime-resolver.js`** 跑真实解析分支（非复制逻辑）+ 源码级正则断言 + eslint。脚本 `tmp/_verify.js`，运行完已删。

---

## 9. 阶段 2：身份源跟随偏好（2026-10-10 完成，未 commit）

### 9.1 为什么必须修（阶段 1 的遗漏）

阶段 1 只让 **可执行文件** 听偏好，**身份克隆源**没跟着改：

```
用户选 Edge
  → 驱动浏览器 = msedge.exe        ✅ 阶段 1 已生效
  → 克隆的身份 = Chrome 的 cookie  ❌ 见 9.2
```

`prepareHmChromeProfile()` 调 `findSystemChromeUserDataDir()` → `findSystemBrowserUserDataDir()`，后者按「Chrome 优先」硬排序，**完全不接收 preference**。后果有两层：

1. **品牌不匹配** —— Akamai 的 `_abck` 是与签发时那套浏览器指纹绑定的，Chrome 签发的身份拿给 Edge 用，正是我们在被拦时追查的那种不匹配；
2. **退出成本没降下来** —— 即使改用 Edge，用户仍必须退出 **Chrome**（克隆源是 Chrome），「只退一个浏览器」的好处拿不到；日志还会误导性地打印 `🔐 Chrome identity copied for H&M`。

> 注：§5 的更正 ① 只说「Edge 路径已支持」——那是**候选路径存在**；「偏好是否生效」是另一件事，本阶段才补上。

### 9.2 改动（`main.js` 单文件）

| 位置 | 改法 |
|---|---|
| `getBrowserIdentityCandidates()`（新增） | 按平台返回 `{ chrome: [...], edge: [...] }`（win32 / darwin / linux 三套），替代原来写死顺序的候选数组 |
| `findSystemBrowserIdentity(preference)`（新增） | 返回 `{ dir, brand }｜null`；`edge` 时先 Edge 后 Chrome，其余先 Chrome 后 Edge |
| `findSystemBrowserUserDataDir(preference)` | 薄包装（返回路径）；**实测零调用者，已删除** |
| `findSystemChromeUserDataDir()` | **删除**（名字带 Chrome 却可返回 Edge，语义已错；唯一调用点同时改掉） |
| `prepareHmChromeProfile(emitLog, preference)` | `preference` = **实际驱动的品牌**；`brandLabel` 动态（Chrome / Edge）；失败对象带 `brandLabel` |
| 品牌切换清理（新增） | `prevMeta.sourceBrand` 与本次源品牌不同时 → `fs.rmSync(dstDefault)` 后重建（**不含** session 根目录，它被 H&M 单品抓取共用）；日志 `🧹 Cleared the previous …` |
| `writeHmIdentityMeta()` | 新增 `sourceBrand` 字段（供上面的切换判断） |
| 各失败/成功文案 | 全部品牌化（`Fully quit ${brandLabel}` / `every msedge.exe`/`chrome.exe`） |
| `describeHmIdentityProblem()` | 按 `result.brandLabel` 生成指引 |
| `buildHmPreflight()` | 判定反转：**驱动品牌**在跑才是问题（原先写死「只有 Chrome 能锁」），`no-identity` 文案同步品牌化 |
| bestseller 调用点 | `const drivenBrand = /msedge/i.test(executablePath) ? 'edge' : 'chrome'; prepareHmChromeProfile(emitLog, drivenBrand)` —— 用**实际解析出的可执行文件**推断，因此「选 Edge 但 Edge 未装 → 回退 Chrome」时身份源也正确跟随 Chrome |

### 9.3 验证（真实源码切测，非复制逻辑）

`node --check main.js` exit 0；`eslint .` = **267 problems (0 errors)**，与基线一致，改动涉及标识符在输出中零命中。

提取 `main.js` 真实源码（`indexOf` + `new Function`，注入 stub 的 `getHmSessionDir` 指向隔离目录）实测：

| 用例 | 结果 |
|---|---|
| `findSystemBrowserIdentity('edge')` | `{dir: …\Microsoft\Edge\User Data, brand: 'edge'}` ← **此前永远返回 Chrome** |
| `findSystemBrowserIdentity('chrome')` / `('auto')` | Chrome User Data |
| `findSystemBrowserIdentity('bogus')` | 回落 Chrome（非 edge 即 Chrome 优先） |
| `prepareHmChromeProfile(log,'edge')`（Edge 在运行） | `brandLabel='Edge'`，文案「Edge is running … every **msedge.exe**」 |
| `prepareHmChromeProfile(log,'chrome')` | `brandLabel='Chrome'` |
| prevMeta.sourceBrand=chrome + preference=edge | 日志 `🧹 Cleared the previous Chrome profile (the H&M identity now comes from Edge).` |
| prevMeta.sourceBrand=edge + preference=chrome | 日志 `🧹 Cleared the previous Edge profile (…)` |
| 无 prevMeta（冷启动） | 不清理 |

### 9.4 阶段 2 实测计划（本机，需完全退出浏览器）

**前置事实（实测）**：本机 `chrome.exe` 15 进程 / `msedge.exe` 9 进程在跑 → Chrome 与 Edge 的 Cookies 均被独占锁（`copyFileSync`、`readFileSync` **双双 EBUSY**）。**Edge 无 H&M 身份**（Edge `Local Storage/leveldb` 9 文件中 0 处含 `hm.com`；Chrome 20 文件中 2 处）。

| 轮次 | 配置 | 前置 | 期望 |
|---|---|---|---|
| **R1 · Chrome 回归** | `preference=chrome`（当前配置值） | 完全退出 Chrome | 与改造前一致成功 → 证明阶段 1+2 未破坏主链路 |
| **R2 · Edge** | `preference=edge` | ① 先在 Edge 里人肉逛 H&M（分类页/商品页）建立身份；② 完全退出 Edge | 日志出现 `🔐 Edge identity copied`；Akamai 是否放行另行判定 |

R2 若被拦且日志显示身份来自 Edge，则结论是「Edge 冷身份」而非品牌问题 —— 养身份多轮后再判。

## 10. 追加：H&M Bestseller 向导极简化（2026-10-10，同批）

用户报障：选 H&M 后浏览器步骤点「下一步」又跳回品牌页；且要求步骤只保留「选浏览器 + 运行检测」。

- **根因**：条件步骤（`showWhen: brand === 'hm'`）排在品牌步骤之前 → `visibleSteps` 下标位移，选中瞬间
  页面被顶走、下一步落回品牌页。规则：**showWhen 依赖的字段必须出现在它之前的步骤里**。
- **改动**：品牌步提前；删 `scraperBrowserNotice` 手动 toggle（检测能验证的事不要让用户口头保证）；浏览器步
  desc 砍到一句；`hmPreflight` 加 `required: true`，并在 `stepValid` 特判
  `params.hmPreflight.ready === true` 作为「下一步」闸门；`HmPreflightPanel` 重写为两行（浏览器已退出 /
  身份就绪）+ Run check 按钮；`buildHmPreflight` 增加只读暴露字段
  （sourceBrand / sourceRunning / cloneReady / identityUsable / ready），不新增探测。
- **ready 语义**：浏览器在跑但有已保存身份 → 放行（运行时克隆失败会回落保存身份）；在跑且无身份 →
  锁死下一步（该组合必失败）。运行前 confirm 弹窗原样保留作安全网。
- **验证**：真实源码切测 17/17（buildHmPreflight 6 场景 + stepValid gate 5 场景 + 步骤顺序）；CDP 驱动真窗口
  实证「选 H&M 不再跳回」（1/4 → 选 H&M → 1/5 且仍在 Brand → Next → 2/5 Scraper Browser）；lint
  0 errors；守卫 31 / 26 / 14；esbuild build exit 0。
