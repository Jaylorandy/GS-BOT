# Windows 版本闪退问题解决指南

## 🔍 诊断步骤

### 手动检查

#### 1. 检查 Chrome 浏览器是否安装

打开文件资源管理器，检查以下路径：

```
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
```

如果找不到 Chrome，请下载安装：
https://www.google.com/chrome/

#### 2. 以管理员身份运行

1. 右键点击 `Zara Scraper Pro.exe` 或桌面快捷方式
2. 选择"以管理员身份运行"

#### 3. 查看错误日志

日志文件位置：
```
%APPDATA%\Zara Scraper Pro\logs\error.log
```

访问方法：
1. 按 `Win + R`
2. 输入 `%APPDATA%` 回车
3. 找到 `Zara Scraper Pro` 文件夹
4. 打开 `logs\error.log`

#### 4. 查看 Windows 事件查看器

1. 按 `Win + X`，选择"事件查看器"
2. 展开左侧的"Windows 日志"
3. 点击"应用程序"
4. 查找 "Zara Scraper Pro" 或 "electron" 相关的错误事件

## 🛠️ 常见问题及解决

### 问题 1: 未找到 Chrome 浏览器

**症状**: 启动后立即弹窗提示"未找到 Chrome 浏览器"

**解决方法**:
1. 下载安装 Google Chrome
2. 确保安装到默认路径
3. 重启应用

### 问题 2: 应用一闪而过

**症状**: 双击后窗口一闪就消失

**可能原因**:
- Chrome 未安装或路径不正确
- 缺少系统依赖
- 防火墙/杀毒软件拦截

**解决方法**:

#### 2.1 安装 Chrome
确保 Chrome 已安装在标准位置

#### 2.2 关闭杀毒软件
暂时关闭杀毒软件，重新运行应用

#### 2.3 添加防火墙例外
1. 打开 Windows 防火墙
2. 点击"允许应用通过防火墙"
3. 找到并添加 "Zara Scraper Pro"

#### 2.4 安装 VC++ 运行库
下载安装 Microsoft Visual C++ Redistributable：
https://aka.ms/vs/17/release/vc_redist.x64.exe

### 问题 3: 缺少系统依赖

**症状**: 启动时提示缺少 DLL 文件

**解决方法**:
1. 安装 .NET Framework 4.8（如果未安装）
   https://dotnet.microsoft.com/download/dotnet-framework/net48

2. 安装 Visual C++ Redistributable
   https://aka.ms/vs/17/release/vc_redist.x64.exe

### 问题 4: 权限不足

**症状**: 提示"访问被拒绝"或"写入失败"

**解决方法**:
1. 右键点击应用，选择"属性"
2. 切换到"兼容性"选项卡
3. 勾选"以管理员身份运行此程序"
4. 点击"确定"

## 📋 诊断信息收集

如果以上方法都无法解决问题，请提供以下信息：

1. **系统信息**:
   - Windows 版本（如：Windows 10 64位）
   - 浏览器版本（Chrome 版本）

2. **错误日志**:
   - `%APPDATA%\Zara Scraper Pro\logs\error.log` 的内容

3. **事件查看器日志**:
   - Windows 事件查看器中的相关错误事件

4. **截图**:
   - 错误提示框的截图
   - 应用闪退时的截图

## 🔧 高级调试

### 使用命令行运行应用

1. 打开命令提示符（CMD）或 PowerShell
2. 导航到应用安装目录：
   ```
   cd "%LOCALAPPDATA%\Programs\Zara Scraper Pro"
   ```
3. 运行应用：
   ```
   "Zara Scraper Pro.exe"
   ```
4. 查看控制台输出

### 检查应用安装完整性

1. 检查以下文件是否存在：
   ```
   %LOCALAPPDATA%\Programs\Zara Scraper Pro\
   ├── resources\
   │   ├── app.asar
   │   └── ...
   └── Zara Scraper Pro.exe
   ```

2. 如果缺少文件，重新运行安装程序

## 💡 预防措施

### 1. 正常使用建议
- 使用稳定的网络连接
- 不要在抓取过程中关闭应用
- 定期清理桌面，保持输出目录可访问

### 2. 杀毒软件设置
将应用目录添加到杀毒软件的白名单：
```
%LOCALAPPDATA%\Programs\Zara Scraper Pro
```

### 3. 系统要求
- Windows 10 或更高版本（64位）
- 至少 4GB RAM
- 至少 500MB 可用磁盘空间

## 📞 获取帮助

如果问题仍未解决，请：

1. 收集诊断信息（见上方）
2. 查看应用官网文档
3. 联系技术支持

---

**最后更新**: 2026-03-13
**版本**: v1.0.0
