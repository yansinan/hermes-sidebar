# 代码优化与重构进展

## 当前阶段：第一步完成 ✓

### 已完成的工作

#### 1. **提取逻辑优化** (`src/background/service-worker.ts`)
- ✅ 提取了通用的 `streamAiResponse()` 函数
  - 可复用于多种提取模式（整页、选中文本等）
  - 处理 API 调用和流式响应消费
  - 完整的错误处理

- ✅ 提取了 `ensureModelId()` 函数
  - 集中管理模型 ID 选择逻辑
  - 支持设置默认值和 API 回退

- ✅ 重构了工作流：将主流程分解为 10 个清晰的步骤
  ```
  Step 1:  提取页面内容
  Step 2:  加载设置
  Step 3:  构建 prompt
  Step 4:  确保模型 ID
  Step 5:  打开侧栏
  Step 6:  创建消息对象
  Step 7:  广播开始信号
  Step 8:  调用 AI API
  Step 9:  创建助手消息
  Step 10: 广播结果
  ```

#### 2. **提示词模板重构** (`src/shared/prompt-templates.ts`)
- ✅ 创建了 `buildPageExtractionPrompt()` - 整页提取的核心逻辑
- ✅ 创建了 `buildSelectedTextQuotePrompt()` - 选中文本一句话摘要
- ✅ 保留了 `buildSummaryPrompt()` - 通用摘要

#### 3. **页面摘要模块精简** (`src/shared/page-body-summary.ts`)
- ✅ 删除了重复逻辑
- ✅ 改为调用新的 `buildPageExtractionPrompt()`
- ✅ 保持向后兼容接口

#### 4. **消息处理增强** (`src/sidepanel/App.tsx`)
- ✅ 完整记录了所有消息类型
- ✅ 添加了详细的 console 日志用于调试
- ✅ 改进了异步响应处理

#### 5. **代码注释** - 所有关键模块
- ✅ service-worker: 详细的工作流文档
- ✅ App.tsx: 消息类型和处理流程
- ✅ prompt-templates: 各函数用途
- ✅ page-body-summary: 接口和功能说明

---

## 下一步计划：实现选中文本功能

### 阶段 2：选中文本提取 (TODO)

#### 需要的改动：

1. **content-script.ts** (新建)
   - 监听用户选中文本
   - 获取选中文本内容
   - 发送 `selection-found` 消息给 service-worker

2. **service-worker.ts** (扩展)
   - 添加第二个 context menu handler：`hermes_extract_selection`
   - 在 `chrome.contextMenus.onClicked` 中处理选中文本
   - 调用 `buildSelectedTextQuotePrompt()` 生成 prompt
   - 获取一句话摘要
   - 发送结果到侧栏作为对话引用

3. **App.tsx** (扩展)
   - 添加消息处理：`add-selection-quote-result`
   - 显示引用在对话框上方

4. **manifest.config.ts** (配置)
   - 添加 `content_scripts` 权限
   - 注册 content-script

#### 工作流设想：
```
用户选中文本 → context menu 出现
            → 右键点击"提取选中文本摘要"
            → service-worker 捕获
            → buildSelectedTextQuotePrompt() 生成提示词
            → API 调用（一句话摘要）
            → 返回结果
            → 显示在对话框上方作为引用上下文
```

---

## 代码架构总结

### 消息流向（当前工作）
```
用户右键菜单
    ↓
chrome.contextMenus.onClicked
    ↓
extractPageMainContent (Readability)
    ↓
buildPageBodySummaryPrompt
    ↓
streamAiResponse (API call)
    ↓
chrome.runtime.sendMessage
    ↓
App.tsx: chrome.runtime.onMessage.addListener
    ↓
controller.addExtractionResult
    ↓
新消息添加到对话
```

### 消息类型
- `extraction-start` - 开始提取（显示 loading）
- `extraction-processing` - 处理中（预留）
- `add-extraction-result` - 添加结果（核心）
- `extraction-error` - 错误处理
- `open-with-draft` - 预留（未来用于直接编辑 prompt）

---

## 技术债务清单

- [ ] 选中文本功能实现
- [ ] 一句话摘要结果作为对话引用
- [ ] 用户可以编辑 prompt 后重新提取
- [ ] 支持批量提取多个页面/文本
- [ ] 缓存已提取的摘要
- [ ] 错误重试机制

---

## 构建状态
- ✅ TypeScript 编译无错误
- ✅ Vite 构建成功
- ✅ 所有依赖正确
- ✅ 可以重新加载扩展进行测试

## 测试检查清单
- [ ] 完整页面提取工作正常
- [ ] API 调用和流式响应正确
- [ ] 消息在 service-worker 和 sidepanel 之间正确传递
- [ ] Console 日志清晰显示每个步骤
- [ ] 错误处理和恢复正常
