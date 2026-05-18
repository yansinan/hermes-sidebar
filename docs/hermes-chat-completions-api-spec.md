# Hermes Chat Completions API — 流式接口定义

> 基于 Hermes Agent 源码 `gateway/platforms/api_server.py`（第 1215–1459 行）整理。
> 用于给其他 agent / 前端 / 客户端对接 Hermes API Server 的 Chat Completions 端点。

---

## 1. 端点概述

| 项 | 值 |
|---|---|
| 端点 | `POST /v1/chat/completions` |
| Base URL | `http://localhost:8642`（默认）或 `http://<host>:8643`（实际环境） |
| 认证 | Bearer Token（`Authorization: Bearer <API_SERVER_KEY>`） |
| Content-Type | `application/json` |
| 模式 | `stream: false`（单次 JSON）或 `stream: true`（SSE 流） |

官方文档：https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

---

## 2. 请求格式

### 2.1 请求 Body

```json
{
  "model": "hermes-agent",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true
}
```

### 2.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 仅作展示用，实际模型由服务端 `config.yaml` 控制。默认 `"hermes-agent"`（或 profile 名） |
| `messages` | array | **是** | 消息列表，标准 OpenAI Chat Completions 格式 |
| `messages[].role` | string | 是 | `"system"`、`"user"`、`"assistant"` |
| `messages[].content` | string | 是 | 消息内容 |
| `stream` | bool | 否 | `true` = SSE 流式返回；`false` = 单次 JSON 返回。默认 `false` |

### 2.3 System Prompt 叠加

前端传入的 `system` 消息会**叠加**在 Hermes 的核心 system prompt 之上，不会覆盖。agent 保留所有工具、内存、Skills。

### 2.4 内联图片输入

`user` 角色的 `content` 支持数组格式，同时发送文本和图片：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What is in this image?"},
    {"type": "image_url", "image_url": {"url": "https://example.com/cat.png", "detail": "high"}}
  ]
}
```

| content[].type | 说明 |
|---|---|
| `text` | 纯文本 |
| `image_url` | 图片，支持 `http(s)` 远程 URL 和 `data:image/...` base64 URL |

不支持：`file`、`input_file`、`file_id` 和非图片 `data:` URL（返回 400）。

---

## 3. 非流式响应（`stream: false`）

### 3.1 成功响应

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "hermes-agent",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Here's a fibonacci function..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 200,
    "total_tokens": 250
  }
}
```

### 3.2 字段定义

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Completion 唯一 ID |
| `object` | string | 固定 `"chat.completion"` |
| `created` | int | Unix 时间戳（秒） |
| `model` | string | 固定 `"hermes-agent"` 或 profile 名 |
| `choices[].index` | int | 固定 `0` |
| `choices[].message.role` | string | 固定 `"assistant"` |
| `choices[].message.content` | string | agent 最终输出文本 |
| `choices[].finish_reason` | string | `"stop"`（正常结束）或 `"error"` |
| `usage.prompt_tokens` | int | 输入 token 数 |
| `usage.completion_tokens` | int | 输出 token 数 |
| `usage.total_tokens` | int | 总 token 数 |

---

## 4. 流式响应（`stream: true`）— SSE 协议

采用 Server-Sent Events（SSE）协议。每个事件独立一行，按固定顺序发送。

### 4.1 SSE 事件类型一览

| 序号 | 事件 | 线协议 | 说明 |
|---|---|---|---|
| ① | Role chunk | `data:` | 声明 assistant 角色 |
| ② | Content delta | `data:` | 逐 token 或逐块的文本片段 |
| ③ | Tool progress | `event: hermes.tool.progress` + `data:` | 工具调用进度（running / completed） |
| ④ | Finish chunk | `data:` | 结束标记 + token 用量汇总 |
| ⑤ | Stream end | `data: [DONE]` | 流终止信号 |

工具执行期间的 `None` delta 会被过滤，不提前结束 SSE 流。

### 4.2 ① Role Chunk

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1710000000,"model":"hermes-agent","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Completion ID（与后续 chunk 共用同一 ID） |
| `object` | string | 固定 `"chat.completion.chunk"` |
| `created` | int | Unix 时间戳 |
| `model` | string | 固定 `"hermes-agent"` 或 profile 名 |
| `choices[].index` | int | 固定 `0` |
| `choices[].delta.role` | string | 固定 `"assistant"` |
| `choices[].finish_reason` | null | 流式过程中恒为 `null` |

### 4.3 ② Content Delta

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Here's"},"finish_reason":null}]}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `choices[].delta.content` | string | 文本片段（逐 token 或逐块）。客户端应持续拼接。 |

### 4.4 ③ Tool Progress（自定义 SSE 事件）

当 agent 调用工具时，Hermes 发射自定义 SSE 事件。`event` 和 `data` 独立成行，前端可独立渲染而不污染对话历史。

```
event: hermes.tool.progress
data: {"tool":"terminal","emoji":"💻","label":"ls -la","toolCallId":"call_xxx","status":"running"}

```

#### 工具开始（`status: running`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` | string | 工具名称（如 `terminal`、`web_search`、`read_file`） |
| `emoji` | string | 工具对应 emoji |
| `label` | string | 工具调用预览（如命令摘要、查询内容） |
| `toolCallId` | string | 工具调用唯一标识，用于前后关联 |
| `status` | string | 固定 `"running"` |

#### 工具完成（`status: completed`）

```
event: hermes.tool.progress
data: {"tool":"terminal","toolCallId":"call_xxx","status":"completed"}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` | string | 工具名称 |
| `toolCallId` | string | 与 `running` 事件相同的 ID，用于配对 |
| `status` | string | 固定 `"completed"` |

**规则：**
- 内部工具（名称以 `_` 开头，如 `_thinking`）**不**发射 progress 事件
- 每个 `toolCallId` 保证先收到 `running` 再收到 `completed`，无悬念事件
- 工具执行期间不发送 content delta；工具完成后再继续

### 4.5 ④ Finish Chunk

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":200,"total_tokens":250}}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `choices[].delta` | object | 空对象 `{}` |
| `choices[].finish_reason` | string | `"stop"`（正常结束）或 `"error"` |
| `usage` | object | 最终 token 用量汇总 |

### 4.6 ⑤ Stream End

```
data: [DONE]

```

客户端检测到 `data: [DONE]` 后应关闭 SSE 连接。

---

## 5. 完整流式时序示例

```text
# 1. Role chunk
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1710000000,"model":"hermes-agent","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

# 2. Content deltas
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Let"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" me"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" check"},"finish_reason":null}]}

# 3. Tool progress — starting
event: hermes.tool.progress
data: {"tool":"terminal","emoji":"💻","label":"ls -la","toolCallId":"call_1","status":"running"}

# (agent runs the tool — no SSE during this period)

# 4. Tool progress — completed
event: hermes.tool.progress
data: {"tool":"terminal","toolCallId":"call_1","status":"completed"}

# 5. More content deltas
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Here"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" are"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" the files"},"finish_reason":null}]}

# 6. Finish chunk
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":200,"total_tokens":250}}

# 7. Stream end
data: [DONE]
```

---

## 6. 注意事项

| 编号 | 说明 |
|---|---|
| 1 | **响应时间**：Hermes Chat Completions 执行的是完整 agent 循环（含多轮工具调用），响应时间从数秒到数分钟不等，不同于纯 LLM 端点 |
| 2 | **model 字段仅作展示**：请求中的 `model` 值不会影响实际使用的模型，模型由服务端配置决定 |
| 3 | **无文件上传**：不支持 `file` / `input_file` / `file_id`，仅支持 `data:image/...` 和 `http(s)` 图片 |
| 4 | **工具执行期间无 content delta**：agent 调用工具时不发送文本 delta，工具完成后继续发送 |
| 5 | `_thinking` 等内部事件不暴露到 SSE 流 |
| 6 | 30 秒无活动时可能发保活注释 `: keepalive\n\n`（仅 Runs API 端有此机制，Chat Completions 端以 0.5s 轮询 + 5 分钟超时保活） |

---

## 7. 快速测试

```bash
# 非流式
curl http://localhost:8642/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"Hello!"}],"stream":false}'

# 流式
curl http://localhost:8642/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```
