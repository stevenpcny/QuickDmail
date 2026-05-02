# QuickDmail — Email Link Collector

> Chrome 扩展 · Manifest V3 · 版本 1.5.0

自动捕获 Gmail 中的验证邮件链接，并集成 DuckDuckGo 私密邮箱地址生成，让批量注册账号的全流程在一个面板内完成。

---

## 主要功能

### 🔗 链接标签页 — 验证链接自动捕获

- **实时监控**：后台持续监听 Gmail 收件箱，验证邮件到达时立即提取激活链接
- **XHR 拦截**：通过注入页面脚本拦截 Gmail 内部 API 请求，即使邮件未被点击也能捕获
- **手动扫描**：支持全量扫描历史收件箱，补捉过去的验证邮件
- **链接操作**：
  - 点击 / 复制按钮 → 链接复制到剪贴板
  - 拖拽链接 → 可直接拖到其他浏览器或标签页打开
  - 打开按钮 → 在新标签页直接打开
- **操作联动**：复制、拖拽、打开任意一个动作后，对应的 Gmail 邮件自动标为**已读**
- **自动轮转**：开启后每次窗口切回时自动复制下一条链接（批量操作场景）
- **导出**：支持 CSV 导出全部捕获数据

### 👤 账号标签页 — 注册邮箱管理

- 自动整理所有出现过的注册邮箱，记录首次 / 最后收件时间及次数
- 支持关键词搜索、按时间过滤（某日期之前 / 时间段内）
- 批量勾选邮箱，一键**轮转复制**邮箱地址（配合批量注册）
- 导出邮箱列表为 CSV
- 可同步到 **Google Sheets**（需配置 OAuth Client ID）

### 🐥 Duck 标签页 — DuckDuckGo 私密邮箱

解决"注册需要邮箱但不想暴露真实地址"的问题，配合批量账号注册使用。

| 功能 | 说明 |
|------|------|
| **一键自动生成** | 有 token 时直接调 DDG API 生成新 Duck 地址，无需打开任何页面 |
| **打开 DDG 页面** | 手动在 DDG 设置页操作；点击 Generate → Copy 后地址自动捕获保存 |
| **历史地址列表** | 记录所有生成过的 `@duck.com` 地址，带生成时间 |
| **链接发光按钮** | 用某个 Duck 地址注册后，当验证邮件到达时，该地址行右侧的链接按钮**自动变绿发光**，点击即可复制验证链接 |
| **Token 配置** | 手动粘贴 Bearer token，用于直接调用 DDG API 生成地址 |

**Duck 地址 → 验证链接匹配逻辑**：以 Duck 地址生成时间为起点，到下一个 Duck 地址生成时间为终点，这段时间内捕获的验证链接自动归属到该地址行。

### ⚙️ 设置标签页

- **监控范围**：全部收件 / 指定 Gmail 标签
- **Google Sheets 同步**：配置表格 URL，自动或手动同步邮箱数据
- **自动移入垃圾桶**：非验证类邮件可选择自动归档
- **自定义激活链接**：修改激活链接关键词，适配不同服务
- **垃圾邮件过滤**：自定义垃圾邮件关键词，精准删除邮件

---

## 完整使用流程

```
1. 点「Duck」标签 → 「一键自动生成」→ 得到一个 xxx@duck.com 地址
2. 用该地址注册账号
3. 服务发验证邮件 → DDG 转发到你的真实 Gmail
4. 插件自动捕获验证链接
5. Duck 标签页对应行的「链接」按钮变绿发光
6. 点击按钮，验证链接复制到剪贴板 → 粘贴到浏览器完成验证
```

---

## 安装方法

1. 下载或 Clone 本仓库
2. 打开 Chrome → 地址栏输入 `chrome://extensions`
3. 开启右上角「**开发者模式**」
4. 点击「**加载已解压的扩展程序**」→ 选择本项目文件夹
5. 打开 Gmail，点击工具栏插件图标即可使用

---

## Token 获取方法（可选，用于直接生成 Duck 地址）

1. 打开 `duckduckgo.com/email/settings/autofill`
2. 按 `F12` 打开开发者工具 → 切到 **Network** 标签
3. 点页面上的「Generate」按钮
4. 找到发往 `quack.duckduckgo.com` 的请求
5. 在 Request Headers 中复制 `Authorization: Bearer` 后面的值
6. 粘贴到插件 Duck 标签页 → 「配置 token」区域 → 保存

---

## 技术说明

| 文件 | 说明 |
|------|------|
| `manifest.json` | Manifest V3，声明权限与 content scripts |
| `content.js` | Gmail 页面注入脚本：DOM 监听、Gmail 已读标记、链接捕获 |
| `page-interceptor.js` | Gmail MAIN world 脚本：拦截 XHR/fetch，提取验证链接和邮件信息 |
| `ddg-page-interceptor.js` | DDG 页面 MAIN world 脚本：拦截剪贴板写入、DOM 轮询、fetch 捕获 Duck 地址 |
| `ddg-content.js` | DDG 页面 ISOLATED world 脚本：接收地址消息并存入 chrome.storage |
| `background.js` | Service Worker：消息路由、Google Sheets 同步、徽章更新、定时监控 |
| `popup.html/js` | 插件弹窗 UI：四个标签页全部功能、设置配置 |

---

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存捕获的链接、邮箱、Duck 地址、配置信息 |
| `tabs` / `scripting` | 向 Gmail 页面注入脚本、执行已读标记、捕获验证链接 |
| `activeTab` | 获取当前标签页信息 |
| `notifications` | 新验证邮件到达时系统通知 |
| `identity` | Google OAuth 授权（Sheets 同步） |
| `alarms` | 定时监控任务 |
| `https://mail.google.com/*` | 监听和操作 Gmail 页面 |
| `https://sheets.googleapis.com/*` | 同步数据到 Google Sheets |
| `https://www.googleapis.com/*` | Google API 调用 |
| `https://quack.duckduckgo.com/*` | 调用 DDG API 生成 Duck 地址 |
| `https://duckduckgo.com/email/*` | 在 DDG 设置页注入捕获脚本 |
