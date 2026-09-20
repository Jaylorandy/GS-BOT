/**
 * Firecrawl 集成示例和前端调用指南
 * 
 * 本文件展示如何在前端 React 组件中配置和使用 Firecrawl
 */

// ═══════════════════════════════════════════════════
// 1. 在设置页面添加 Firecrawl API Key 配置
// ═══════════════════════════════════════════════════

/*
在 Settings.jsx 或类似配置组件中添加:

import { useState, useEffect } from 'react';

function FirecrawlSettings() {
  const [apiKey, setApiKey] = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [saving, setSaving] = useState(false);

  // 加载当前配置
  useEffect(() => {
    window.electronAPI?.invoke('firecrawl-get-config').then(result => {
      if (result.success) {
        setIsConfigured(result.isConfigured);
      }
    });
  }, []);

  // 保存 API Key
  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI?.invoke('firecrawl-save-config', apiKey);
      if (result.success) {
        setIsConfigured(true);
        alert('Firecrawl 配置已保存!');
      } else {
        alert(`保存失败: ${result.error}`);
      }
    } catch (error) {
      alert(`保存出错: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="firecrawl-settings">
      <h3>🔥 Firecrawl 备用抓取引擎</h3>
      <p className="hint">
        当本地 IP 被封禁时,自动切换到 Firecrawl 云端代理池继续抓取
      </p>
      
      <div className="form-group">
        <label>API Key:</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="输入 Firecrawl API Key (fc-xxx...)"
          disabled={saving}
        />
      </div>
      
      <div className="status">
        {isConfigured ? (
          <span className="success">✅ 已配置</span>
        ) : (
          <span className="warning">⚠️ 未配置</span>
        )}
      </div>
      
      <button onClick={handleSave} disabled={saving || !apiKey}>
        {saving ? '保存中...' : '保存配置'}
      </button>
      
      <div className="help">
        <a href="https://www.firecrawl.dev/" target="_blank" rel="noopener noreferrer">
          获取 API Key →
        </a>
      </div>
    </div>
  );
}
*/

// ═══════════════════════════════════════════════════
// 2. 在抓取任务中显示 Firecrawl 降级提示
// ═══════════════════════════════════════════════════

/*
在主抓取界面添加状态显示:

function ScraperStatus({ firecrawlFallback }) {
  return (
    <div className="scraper-status">
      {firecrawlFallback && (
        <div className="alert warning">
          ⚠️ 检测到本地 IP 被封禁,已自动切换到 Firecrawl 备用引擎
        </div>
      )}
    </div>
  );
}
*/

// ═══════════════════════════════════════════════════
// 3. 成本估算工具
// ═══════════════════════════════════════════════════

/**
 * 计算 Firecrawl 使用成本
 * @param {number} styleCount - 款号数量
 * @returns {Object} 成本估算
 */
function estimateFirecrawlCost(styleCount) {
  const costPerPage = 0.01; // $0.01/次抓取
  const totalCost = styleCount * costPerPage;
  
  return {
    perStyle: costPerPage,
    totalStyles: styleCount,
    estimatedTotal: totalCost.toFixed(2),
    currency: 'USD',
    note: '实际费用取决于 Firecrawl 定价策略'
  };
}

// 示例:
// estimateFirecrawlCost(100) 
// → { perStyle: 0.01, totalStyles: 100, estimatedTotal: "1.00", currency: "USD" }

// ═══════════════════════════════════════════════════
// 4. 测试 Firecrawl 连通性
// ═══════════════════════════════════════════════════

/**
 * 测试 Firecrawl API 是否可用
 */
async function testFirecrawlConnection() {
  try {
    const testUrl = 'https://www.zara.com/us/en/-p01934470.html';
    
    // 通过后端调用 Firecrawl
    const result = await window.electronAPI?.invoke('test-firecrawl-scrape', testUrl);
    
    if (result.success) {
      console.log('✅ Firecrawl 连接成功');
      console.log('抓取到的 HTML 长度:', result.html?.length);
      return true;
    } else {
      console.error('❌ Firecrawl 测试失败:', result.error);
      return false;
    }
  } catch (error) {
    console.error('测试出错:', error);
    return false;
  }
}

// ═══════════════════════════════════════════════════
// 5. 监控 Firecrawl 使用情况
// ═══════════════════════════════════════════════════

/**
 * 记录 Firecrawl 使用统计
 */
class FirecrawlUsageTracker {
  constructor() {
    this.usage = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalCost: 0,
      lastUsed: null,
    };
  }

  recordCall(success, cost = 0.01) {
    this.usage.totalCalls++;
    if (success) {
      this.usage.successfulCalls++;
    } else {
      this.usage.failedCalls++;
    }
    this.usage.totalCost += cost;
    this.usage.lastUsed = new Date().toISOString();
    
    // 保存到 localStorage
    localStorage.setItem('firecrawl_usage', JSON.stringify(this.usage));
  }

  getStats() {
    return {
      ...this.usage,
      successRate: this.usage.totalCalls > 0 
        ? ((this.usage.successfulCalls / this.usage.totalCalls) * 100).toFixed(1) + '%'
        : '0%',
    };
  }

  loadFromStorage() {
    const saved = localStorage.getItem('firecrawl_usage');
    if (saved) {
      this.usage = JSON.parse(saved);
    }
  }
}

// 使用示例:
// const tracker = new FirecrawlUsageTracker();
// tracker.loadFromStorage();
// tracker.recordCall(true); // 成功的调用
// console.log(tracker.getStats());

export {
  estimateFirecrawlCost,
  testFirecrawlConnection,
  FirecrawlUsageTracker,
};
