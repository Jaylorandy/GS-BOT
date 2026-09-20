# Firecrawl 备用抓取引擎集成指南

## 📋 概述

GS Bot 现已集成 Firecrawl API 作为 Puppeteer 的备用抓取引擎,用于在本地 IP/设备指纹被封禁时自动降级到云端代理池继续抓取。

---

## 🚀 快速开始

### 1. 获取 Firecrawl API Key

访问 [https://www.firecrawl.dev/](https://www.firecrawl.dev/) 注册账号并获取 API Key。

免费额度通常包含 100-500 次试用请求。

### 2. 配置 API Key

**方式 A: 通过设置界面(推荐)**

在 GS Bot 的设置页面中找到 "Firecrawl 配置" 区域,输入 API Key 并保存。

**方式 B: 手动配置文件**

创建文件 `~/Library/Application Support/GS Bot/firecrawl-config.json` (macOS) 或 `%APPDATA%\GS Bot\firecrawl-config.json` (Windows):

```json
{
  "apiKey": "fc-your-api-key-here"
}
```

### 3. 验证配置

重启 GS Bot 后,系统会自动加载配置。开始抓取任务时,如果检测到本地 IP 被封禁,会自动切换到 Firecrawl。

---

## 🔧 工作原理

### 架构设计

```
用户输入款号
    ↓
尝试 Puppeteer 抓取
    ↓
成功? → 继续使用 Puppeteer(零成本)
    ↓
失败且检测到封禁?
    ↓
自动降级到 Firecrawl API
    ↓
返回抓取结果(付费但可靠)
```

### 封禁检测逻辑

系统会检测以下错误特征:
- HTTP 403 Forbidden
- "Access Denied" / "Cloudflare"
- "net::ERR_BLOCKED_BY_CLIENT"
- 连接超时或速率限制

触发任一条件即判定为封禁,自动切换引擎。

---

## 💰 成本估算

| 场景 | 单次成本 | 100 款月成本 |
|------|---------|-------------|
| **Puppeteer(正常)** | $0 | $0 |
| **Firecrawl(降级)** | ~$0.01 | ~$1 |
| **混合模式(平均)** | ~$0.005 | ~$0.5 |

> **提示**: 大部分情况下仍使用免费的 Puppeteer,仅在被封禁时才消耗 Firecrawl 额度。

---

## 📊 监控使用情况

前端可通过以下方式查看 Firecrawl 使用统计:

```javascript
// 在 React 组件中调用
const usage = await window.electronAPI.invoke('firecrawl-get-usage');
console.log(usage);
// {
//   totalCalls: 15,
//   successfulCalls: 14,
//   failedCalls: 1,
//   totalCost: 0.15,
//   successRate: "93.3%"
// }
```

---

## 🛠️ 高级配置

### 调整降级阈值

编辑 `firecrawl-service.js`,修改 `isBlockedError()` 函数以自定义封禁检测规则。

### 强制使用 Firecrawl

在某些特殊场景下,可以强制所有请求走 Firecrawl:

```javascript
// 在 main.js 中临时修改
const FORCE_FIRECRAWL = true; // 设置为 true 强制使用
```

---

## ❓ 常见问题

### Q: Firecrawl 能绕过所有反爬吗?

A: Firecrawl 能绕过大多数常见反爬(Cloudflare、Akamai、IP 封禁等),但对于需要登录或极端复杂的验证码系统,成功率可能降低。

### Q: 如何知道当前使用的是哪个引擎?

A: 抓取日志中会显示:
- `🔄 Using Firecrawl for XXX...` → 正在使用 Firecrawl
- 无此提示 → 使用 Puppeteer

### Q: API Key 泄露怎么办?

A: 
1. 立即在 Firecrawl 控制台重置 API Key
2. 更新本地配置文件
3. 检查是否有异常使用记录

### Q: 可以完全禁用 Firecrawl 吗?

A: 可以,删除 `firecrawl-config.json` 文件或清空 API Key 即可。系统会自动回退到纯 Puppeteer 模式。

---

## 📝 技术细节

### 核心文件

- `firecrawl-service.js` - Firecrawl API 封装模块
- `main.js` (第 31 行) - 引入 firecrawlService
- `main.js` (约 18863 行) - IPC 配置处理器

### API 端点

- `firecrawl-get-config` - 获取当前配置状态
- `firecrawl-save-config` - 保存 API Key

### 依赖项

无需额外安装 npm 包,使用 Node.js 内置 `https` 模块调用 API。

---

## 🔗 相关资源

- [Firecrawl 官方文档](https://docs.firecrawl.dev/)
- [Firecrawl GitHub](https://github.com/mendableai/firecrawl)
- [GS Bot 项目主页](./README.md)

---

## 📞 支持

如遇问题,请:
1. 检查 API Key 是否有效
2. 查看 GS Bot 日志 (`~/Library/Application Support/GS Bot/logs/error.log`)
3. 联系技术支持
