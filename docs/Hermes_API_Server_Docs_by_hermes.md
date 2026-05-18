---
title: API Server
created: 2026-05-08
updated: 2026-05-18
type: concept
tags: [reference, concept, hermes, ops]
sources:
  - raw/articles/API Server Hermes Agent.md
confidence: high
---

# API Server

Hermes Agent 的 API Server 把 agent 暴露成 OpenAI-compatible HTTP 端点。它适合把 Hermes 接到 [[Open WebUI]]、LobeChat 这类前端，或者把 Hermes 当成一个可被外部系统调用的后端服务。

## 这是什么

- 作用是把 [[Hermes Agent]] 包成 HTTP 服务
- 入口通常通过 `hermes gateway` 启动
- 对外提供 chat completions、responses、models、capabilities、health 等接口
- 流式模式下会把工具执行进度一起发给前端

## 核心接口

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/responses/{id}`
- `DELETE /v1/responses/{id}`
- `GET /v1/models`
- `GET /v1/capabilities`
- `GET /health`
- `GET /health/detailed`

## 配置与安全

- 通过 `~/.hermes/.env` 打开 `API_SERVER_ENABLED=true`
- 用 `API_SERVER_KEY` 设置访问密钥
- 需要跨域时再配 `API_SERVER_CORS_ORIGINS`
- 默认只监听 `127.0.0.1`
- 生产环境要同时控制 key 和 CORS

## 适用场景

- 给 OpenAI-compatible 前端提供后端
- 把 Hermes 嵌进已有产品或脚本链路
- 需要状态保持的多轮对话
- 需要把工具调用、文件操作、搜索和记忆统一暴露出去

## Chat Completions 接口定义

`POST /v1/chat/completions` 标准 OpenAI Chat Completions 格式，支持 `stream: true`（SSE）和 `stream: false`（单次 JSON）。

来源：源码 `gateway/platforms/api_server.py`（第 1344–1459 行 SSE 流写入、第 1215–1342 行非流式响应组装）

### 请求格式

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

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 仅作展示，实际模型由服务端 `config.yaml` 控制 |
| `messages` | array | **是** | 消息列表，标准 OpenAI 格式 |
| `messages[].role` | string | 是 | `"system"`、`"user"`、`"assistant"` |
| `messages[].content` | string | 是 | 消息内容 |
| `stream` | bool | 否 | `true` = SSE 流式；`false` = 单次 JSON。默认 `false` |

**System Prompt 叠加**：前端传入的 `system` 消息**叠加**在 Hermes 核心 prompt 之上，不覆盖。agent 保留所有工具、内存、Skills。

**内联图片输入**：`user` 角色支持数组格式同时传文本和图片：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What is in this image?"},
    {"type": "image_url", "image_url": {"url": "https://example.com/cat.png", "detail": "high"}}
  ]
}
```

支持 `http(s)` 远程 URL 和 `data:image/...` base64 图片。不支持 `file` / `input_file` / `file_id`（返回 400）。

### 非流式响应（`stream: false`）

单次返回，标准 OpenAI Chat Completion 格式：

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

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | completion ID |
| `object` | string | 固定 `"chat.completion"` |
| `created` | int | Unix 时间戳 |
| `model` | string | 固定 `"hermes-agent"`（或 profile 名） |
| `choices[].index` | int | 固定 0 |
| `choices[].message.role` | string | 固定 `"assistant"` |
| `choices[].message.content` | string | agent 最终输出文本 |
| `choices[].finish_reason` | string | `"stop"` 或 `"error"` |
| `usage` | object | token 用量 |

### 流式模式（`stream: true`）

SSE 流，按顺序发送以下事件。

#### ① Role chunk — 角色声明

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"hermes-agent","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `object` | string | `"chat.completion.chunk"` |
| `choices[].delta.role` | string | 固定 `"assistant"` |

#### ② Token content delta — 逐 token 回复内容

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Here's"},"finish_reason":null}]}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `object` | string | `"chat.completion.chunk"` |
| `choices[].delta.content` | string | 文本片段（逐 token / 逐块） |

#### ③ `event: hermes.tool.progress` — 工具调用进度

当 agent 调工具时，Hermes 发射自定义 SSE 事件，不走 `data:` 行，前端可独立处理且不污染对话历史。

```
event: hermes.tool.progress
data: {"tool":"terminal","emoji":"💻","label":"ls -la","toolCallId":"call_xxx","status":"running"}

```

**工具开始（`status: running`）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` | string | 工具名称（如 `terminal`、`web_search`） |
| `emoji` | string | 工具对应 emoji（来自 `agent.display.get_tool_emoji`） |
| `label` | string | 工具调用预览（来自 `agent.display.build_tool_preview`） |
| `toolCallId` | string | 工具调用唯一标识，用于前后关联 |
| `status` | string | 固定 `"running"` |

**工具完成（`status: completed`）：**

```
event: hermes.tool.progress
data: {"tool":"terminal","toolCallId":"call_xxx","status":"completed"}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` | string | 工具名称 |
| `toolCallId` | string | 与开始事件相同的 ID |
| `status` | string | 固定 `"completed"` |

注意：
- 内部工具（名字以 `_` 开头，如 `_thinking`）**不**发射 progress 事件（源码第 1175 行）
- 每个 `toolCallId` 保证先收到 `running` 再收到 `completed`，不会出现孤儿事件（源码第 1195 行）
- agent 运行工具期间 `None` delta（CLI 的关闭信号）会被过滤掉，不会提前结束 SSE 流（源码第 1146–1154 行）

#### ④ Finish chunk — 结束标记

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":200,"total_tokens":250}}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `choices[].finish_reason` | string | `"stop"`（正常结束）或 `"error"` |
| `usage` | object | token 用量汇总 |

#### ⑤ Stream end

```
data: [DONE]

```

### 流式事件顺序（典型）

```text
data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Let"}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":" me"}}]}

... 更多 content delta ...

event: hermes.tool.progress
data: {"tool":"terminal","toolCallId":"call_1","status":"running","label":"ls -la","emoji":"💻"}

... agent 执行工具 0.5–30s ...

event: hermes.tool.progress
data: {"tool":"terminal","toolCallId":"call_1","status":"completed"}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Here"}}]}

... 更多 content delta ...

data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}

data: [DONE]
```

### 快速测试

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

端口以实际配置为准（本机为 `8643`）。

## Runs API 接口定义

`POST /v1/runs` 创建异步 agent 任务（非流式、可轮询、可中断），通过 `GET /v1/runs/{run_id}/events` 订阅进度。

来源：源码 `gateway/platforms/api_server.py`（第 2862–3370 行）

### 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/runs` | 创建 run，返回 `run_id` |
| `GET` | `/v1/runs/{run_id}` | 轮询 run 状态 |
| `GET` | `/v1/runs/{run_id}/events` | SSE 事件流订阅 |
| `POST` | `/v1/runs/{run_id}/stop` | 中断运行中的 agent |
| `POST` | `/v1/runs/{run_id}/approval` | 审批决议 |

### POST /v1/runs — 创建 Run

**请求 Body：**

```json
{
  "input": "List files in my project",
  "instructions": "You are a helpful coding assistant.",
  "session_id": "my-session-123",
  "model": "hermes-agent",
  "previous_response_id": "resp_abc123",
  "conversation_history": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!"}
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string \| array | **是** | 用户输入。字符串或消息数组（末条为当前输入，其余为历史） |
| `instructions` | string | 否 | 临时 system prompt，叠加在核心 prompt 之上 |
| `session_id` | string | 否 | 自定义会话 ID |
| `model` | string | 否 | 仅作展示，实际模型由服务端控制 |
| `previous_response_id` | string | 否 | 关联前一次 response，自动恢复上下文 |
| `conversation_history` | array | 否 | 显式历史消息，优先级高于 `previous_response_id` |

**响应 202：**

```json
{"run_id": "run_abc123def456", "status": "started"}
```

**并发限制：** 最大 10 个并发 runs，超出返回 `429 rate_limit_exceeded`。

### GET /v1/runs/{run_id} — 轮询状态

**响应 200：**

```json
{
  "object": "hermes.run",
  "run_id": "run_abc123def456",
  "status": "running",
  "created_at": 1710000000.0,
  "updated_at": 1710000010.0,
  "session_id": "my-session-123",
  "model": "hermes-agent",
  "last_event": "tool.completed"
}
```

**状态机：**

```
queued → running → completed （正常结束）
                 → failed    （执行出错 / 401/400 / 异常）
                 → cancelled （被 stop 中断）
running → waiting_for_approval → running（审批通过后继续）
```

终端状态（`completed`/`failed`/`cancelled`）保留 3600 秒。终端状态额外字段：`output`（completed）、`usage`（completed）、`error`（failed）。

### POST /v1/runs/{run_id}/stop — 中断 Run

无需 Body。响应 200：`{"run_id":"run_abc123","status":"stopping"}`。agent 被 interrupt 后进入 `cancelled` 状态。

### POST /v1/runs/{run_id}/approval — 审批决议

```json
{"choice": "once", "all": false}
```

`choice` 可选值：`once`（一次）、`session`（会话）、`always`（始终）、`deny`（拒绝）。别名：`approve`/`approved`/`allow` → `once`。`all`/`resolve_all` 指示是否一次性解决所有待审批。

### SSE 事件参考

`GET /v1/runs/{run_id}/events` — 标准 SSE，每行 `data:` 后一个 JSON。30 秒无事件发 `: keepalive\\n\\n`，run 结束时发 `: stream closed\\n\\n`。

#### `tool.started` — 工具调用开始

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | string | `\"tool.started\"` |
| `run_id` | string | run 标识 |
| `timestamp` | float | Unix 时间戳 |
| `tool` | string | 工具名称（如 `terminal`） |
| `preview` | string\|null | 工具输入摘要 |

#### `tool.completed` — 工具调用完成

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | string | `\"tool.completed\"` |
| `run_id` | string | run 标识 |
| `timestamp` | float | Unix 时间戳 |
| `tool` | string | 工具名称 |
| `duration` | float | 执行耗时（秒，3 位小数） |
| `error` | bool | 是否出错 |

#### `reasoning.available` — 推理过程

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | string | `\"reasoning.available\"` |
| `run_id` | string | run 标识 |
| `timestamp` | float | Unix 时间戳 |
| `text` | string | 推理文本 |

注：`_thinking` 和 `subagent_progress` **不**转发。

#### `message.delta` — 流式文本

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | string | `\"message.delta\"` |
| `run_id` | string | run 标识 |
| `timestamp` | float | Unix 时间戳 |
| `delta` | string | 文本片段（逐 token） |

#### `approval.request` — 请求审批

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | string | `\"approval.request\"` |
| `run_id` | string | run 标识 |
| `timestamp` | float | Unix 时间戳 |
| `prompt` | string | 审批提示 |
| `choices` | array | `["once","session","always","deny"]` |

触发时 run 状态变为 `waiting_for_approval`。

#### `approval.responded` — 审批已响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `event` | string | `\"approval.responded"` |
| `run_id` | string | run 标识 |
| `timestamp` | float | Unix 时间戳 |
| `choice` | string | 用户选择 |
| `resolved` | int | 解决的审批数 |

#### `run.completed` — Run 正常结束

```json
{
  "event": "run.completed",
  "run_id": "run_abc123",
  "timestamp": 1710000010.0,
  "output": "Final response...",
  "usage": {"input_tokens": 150, "output_tokens": 320, "total_tokens": 470}
}
```

#### `run.failed` — Run 执行失败

```json
{
  "event": "run.failed",
  "run_id": "run_abc123",
  "timestamp": 1710000005.0,
  "error": "agent run failed"
}
```
触发路径：agent 返回结构化失败（401/400）or Python 异常。

#### `run.cancelled` — Run 被中断

```json
{
  "event": "run.cancelled",
  "run_id": "run_abc123",
  "timestamp": 1710000003.0
}
```
触发条件：`POST /v1/runs/{run_id}/stop` 导致 `CancelledError`。

#### 典型事件流

```text
: keepalive\n\n                              ← 30 秒无事件
data: {"event": "tool.started", ...}
data: {"event": "reasoning.available", ...}
data: {"event": "tool.completed", ...}
data: {"event": "message.delta", "delta":"Your"}
data: {"event": "message.delta", "delta":" project"}
data: {"event": "run.completed", ...}
: stream closed\n\n                          ← 流结束
```

有审批的场景：

```text
data: {"event": "tool.started", ...}
data: {"event": "approval.request", "choices":["once","session","always","deny"]}
... 客户端调 POST /v1/runs/{run_id}/approval ...
data: {"event": "approval.responded", "choice":"once", "resolved":1}
data: {"event": "tool.completed", ...}
data: {"event": "run.completed", ...}
: stream closed\n\n
```

### 快速测试

```bash
# 创建 run
curl -X POST http://localhost:8642/v1/runs \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"input":"List files","model":"hermes-agent"}'

# 轮询状态
curl http://localhost:8642/v1/runs/run_abc123 \
  -H "Authorization: Bearer your-api-key"

# 订阅事件流
curl -N http://localhost:8642/v1/runs/run_abc123/events \
  -H "Authorization: Bearer your-api-key"

# 中断 run
curl -X POST http://localhost:8642/v1/runs/run_abc123/stop \
  -H "Authorization: Bearer your-api-key"

# 审批
curl -X POST http://localhost:8642/v1/runs/run_abc123/approval \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"choice":"once"}'
```

端口以实际配置为准（本机为 `8643`）。

## 关联

- [[Hermes Agent]]
- [[OpenClaw]]
- [[vLLM]]
- [[浏览器自动化]]
