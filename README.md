# AI Product Workflow V0

最小可运行产品工作流：验证 `模糊需求 → Discovery → Product Solution → PRD Requirement Details → Codex Figma Prototype Prompt`。

## 当前实现

- Discovery / Product Solution Stage Runtime Prompt
- Product Spec + Workflow State
- Stage Registry
- Context Builder
- OpenAI Responses API 单次调用普通 Turn（异常校验失败最多一次 repair）
- ChatGPT Manual Bridge（实验性）
  - 与 API / Local Codex 模式并存，可随时切换
  - Workflow 生成包含当前 Stage Context 与结构化协议的 Prompt
  - 用户手动 Copy 到 ChatGPT、Paste 完整返回；不调用第二个模型解释结果
  - 自然语言回答正常进入会话，固定边界内的 JSON 复用现有 Turn Schema、Validation、State Update 和 Repository
  - Prompt 同时绑定 Product Spec Revision、Project Record Version 与回合完整性 Token，过期或错配返回整轮拒绝
- 2 个 Stage-specific Model-facing Turn Tool：`complete_discovery_turn`、`complete_solution_turn`
- 5 个 Server-side deterministic operations
  - `update_product_spec`
  - `manage_open_question`
  - `record_decision`
  - `request_validation`
  - `evaluate_stage`
- Discovery / Product Solution Ready 与 Confirm state machine
- Confirmed Product State
  - Product Solution 确认后由程序确定性冻结当前 Discovery、Solution、Active Decisions、Relevant Open Questions、Evidence 和 Assumptions
  - 下游 Artifact 通过 stateVersion 和 contentHash 校验来源，不再直接消费可变聊天历史
- Fastify API
- API & Model Library
  - 保存多个 OpenAI-compatible API 配置及其模型列表
  - 在 Web Workspace 中切换当前 Provider / Model，不修改 Workflow
  - API Key 仅写入本机服务端 `.runtime/provider-library.json`，接口只返回脱敏值
- Discovery Workspace（Conversation + Live Product Spec）
- Product Solution Workspace（Solution Conversation + Current Product Solution）
- PRD Artifact Generator
  - 读取已确认的结构化 Discovery / Product Solution
  - Meta Function Call 选择现有 PRD Capability Prompt
  - 程序化 Prompt Selection / Assembly
  - PRD Generation Function Call
  - 阻塞问题与人工回答持久化；复用已选 Prompt 单次续生成，不重复调用 Meta
  - Draft 编辑、人工确认和上游变更后的 Stale 标记
- Interaction Specification Generator
  - 读取 Confirmed Product State 和已确认 PRD
  - 原样使用现有 `Interaction Design Prompt V2.md`
  - 单次 Generation Function Call，支持编辑、确认、澄清和业务问题回流
- Codex Figma Prompt Assembler
  - 读取 Confirmed Product State、已确认 PRD 和已确认 Interaction Specification
  - Figma Meta Function Call 选择现有 Capability
  - 程序化组装 Figma Base V2、Capability、Reusable Asset Registry 和 Project Context
  - 只输出可复制给 Codex 的 Figma 原型制作提示词，不调用或修改 Figma
- 本地持久化 Project Repository
  - 每个项目独立保存为 `.runtime/projects/<PROJECT_ID>.json`
  - 历史项目列表、恢复、重命名、JSON 导出和整项目删除
  - PRD / Figma Prompt 产物状态、大小与依赖感知清理
- PostgreSQL V0 schema（下一步替换 repository）

当前服务已实现 PRD Requirement Details、Interaction Specification 和 Codex Figma Prompt Artifact。Interaction 属于 Generation Layer，不通过 Decision Runtime 修改 Product Spec；服务不会自动调用 Figma 制作原型。

## 本地项目存储

服务默认把项目写入 `.runtime/projects/`，重启后会自动恢复；该目录已加入 `.gitignore`，不会把需求内容提交进源码仓库。每次保存使用临时文件原子替换，并保留 `recordVersion` 并发写保护。可通过 `WORKFLOW_DATA_DIR` 指定其他存储目录。Repository 接口保持独立，后续替换 PostgreSQL 不需要修改 Runtime。

## Run

需要 Node.js 20 或更新版本；本地已验证版本记录在 `.node-version`（24.19.0）。项目默认使用本地文件持久化，无需启动 PostgreSQL。

Windows 可直接双击 [`启动 Workflow.bat`](./启动%20Workflow.bat)。脚本会复用 AI Settings 中上次激活的 Provider；若服务已经运行则直接打开浏览器，否则检查 Node、pnpm 和 3000 端口，启动服务并在健康检查通过后打开 `http://localhost:3000`。如果保存的 Codex Local 登录已失效且已有 Relay 配置，启动时会自动回退到 Relay，避免因无法进入 AI Settings 而卡死；没有可用回退时，启动日志会给出具体原因。

```bash
pnpm install
cp .env.example .env.local
# 在 .env.local 中设置 AI_PROVIDER 和对应 Provider 配置
pnpm typecheck
pnpm test
pnpm dev
```

启动后访问 `http://localhost:3000`，即可通过双栏 Workspace 完成 Discovery 与 Product Solution；Solution 确认后可以按现有 PRD Prompt Registry 自动选择并组装 Prompt，生成、编辑和确认 PRD Requirement Details。服务默认仅监听 `127.0.0.1`，避免未认证的项目与 Provider 管理接口暴露到局域网；只有在明确需要远程访问并已配置网络访问控制时，才应通过 `HOST` 改为其他监听地址。

页面右上角的 `AI Settings` 可管理 API 与模型库：新增多个 OpenAI-compatible API、为每个 API 保存多个模型，并切换当前使用的 Provider / Model。切换立即作用于后续模型调用，进行中的请求继续使用它开始时的 Provider。Codex Local 作为内置配置保留。

Conversation 标题区的 `Interaction mode` 可切换到实验性的 `ChatGPT Manual Bridge`。在该模式下，发送和应用回复都不会调用已配置的 Provider；把 ChatGPT 的完整回答粘贴回 Bridge 卡片并通过本地校验后，Workflow 才会原子更新 Product State、Decision、Open Question、Stage 状态与会话记录。ChatGPT Memory 可用于用户偏好、工作习惯和跨项目经验，但 Prompt 明确规定当前 Project State 是项目业务事实的唯一可信来源。

Decision Memory 默认不在主对话后自动调用模型。需要补充整理历史对话中的隐含决策时，展开右侧 `Decision Memory` 并点击 `整理决策`；明确决策仍优先由正常 Stage Turn 的 `record_decision` 保存。

V0 不持久化尚未应用的 Bridge Prompt 或粘贴草稿；刷新页面后需要从当前最新项目状态重新生成该回合。已成功应用的对话和结构化状态仍按原 Repository 正常持久化。

如需运行浏览器 E2E，先以 `--remote-debugging-port=9223` 启动本机 Chrome，再执行：

```bash
pnpm e2e:workspace
```

本地环境优先读取 `.env.local`；仅在它不存在时读取 `.env`，不会同时加载两个文件。进程环境变量优先于文件。两个文件都已加入 `.gitignore`。

Provider 只在 `src/ai/provider-factory.ts` 中根据 `AI_PROVIDER` 选择；Workflow、Service、Prompt、Domain Model、Confirmed State 和 Ready Semantics 均继续只依赖 `provider.generate(...)`。

API 与模型库默认保存在服务端 `.runtime/provider-library.json`，该目录已被 Git 忽略。浏览器接口永远不返回完整 API Key，只返回 `hasApiKey` 和末四位脱敏信息。可通过 `WORKFLOW_PROVIDER_LIBRARY_PATH` 指定其他本机路径。启动时 `AI_PROVIDER=codex` 会选择内置 Codex；`AI_PROVIDER=relay` 会恢复上次选中的 API 配置，若尚未保存配置则从 `MODELFLARE_*` 初始化默认 Relay。

默认通过 OpenAI-compatible Responses API 接入 Relay/ModelFlare：

```dotenv
HOST=127.0.0.1
AI_PROVIDER=relay
MODELFLARE_API_KEY=
MODELFLARE_BASE_URL=https://modelflare.dev/v1
MODELFLARE_MODEL=gpt-5.6-terra
```

使用本机 Codex CLI：

```dotenv
AI_PROVIDER=codex
# 可选
# CODEX_COMMAND=codex
# CODEX_MODEL=
# CODEX_TIMEOUT_MS=240000
# CODEX_MAX_RETRIES=0
```

Codex Provider 使用 `codex exec` 非交互运行，固定采用 `read-only` sandbox、`approval_policy="never"`、禁用 shell/web/apps/multi-agent，并从操作系统临时目录中的独立运行目录执行。每次调用只写入 JSON Schema 和输出文件，使用 `--output-schema` 与 `-o` 获取结果；不会从 stdout 截取 JSON，也不会使用 OpenAI API Key。启动前需先运行一次 `codex login` 完成本机 CLI 登录。

当前 Provider 状态可通过健康接口确认：

```bash
curl http://localhost:3000/health
# {"ok":true,"provider":"Codex Local","providerId":"codex","profileId":"codex-local","profile":"Codex Local","model":"CLI default","status":"Ready"}
```

Provider 默认使用非流式 Responses 请求，以兼容会主动断开长工具调用 SSE 连接的 OpenAI-compatible 中转站。单次请求超时为 240 秒，临时连接错误、HTTP 429 和 5xx 最多重试一次，并为同一模型调用复用幂等键。工作流校验失败后的 repair 最多调用一次、默认 180 秒且不再叠加 Provider 重试，避免一次提交持续等待十几分钟。确认中转站能够稳定承载长流式工具调用后，可显式设置 `MODELFLARE_STREAMING=1`；其他参数可通过 `MODELFLARE_TIMEOUT_MS`、`MODELFLARE_REPAIR_TIMEOUT_MS`、`MODELFLARE_MAX_RETRIES` 和 `MODELFLARE_MAX_OUTPUT_TOKENS` 调整。ModelFlare 超时返回 HTTP 504；连接失败、流传输失败、临时不可用或输出长度不足返回可安全重试的 HTTP 502。

Discovery 与 Product Solution 请求会按 `x-request-id` 暴露只包含阶段和耗时元数据的 `/requests/<request-id>` 进度；Workspace 用它区分 Provider 调用、Provider 重试、本地工作流校验、repair 和保存阶段，不记录模型正文或 API key。

Stage Turn 在执行前包含一层安全兼容适配：可归一化 camelCase/snake_case 字段、常见字段别名、大小写枚举、单值/数组、Markdown JSON、缺失的 Ready criteria、简写 Product Spec/Decision 路径和可恢复的 revision 元数据。一个不完整的非安全关键操作会被跳过并以系统提示记录，其余安全操作和对话仍会保存；跨阶段写入、原型污染路径以及真正的并发版本冲突仍按硬错误整轮拒绝。

`MODELFLARE_API_KEY` 只保留在服务端，未配置时对话接口返回 HTTP 503。旧的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 仍可作为兼容后备，但项目默认配置使用 `MODELFLARE_*`。每个 Turn batch 必须传入当前上下文的 `productSpecRevision` 作为 `expectedRevision`。并发保存冲突会返回 HTTP 409，客户端应读取最新项目后重试。

真实 Responses API smoke test 默认不属于 `pnpm test`：

```bash
pnpm smoke:ai
```

通过完整 Route → Runtime → Provider → Tool Loop → Executor → Repository 链路进行交互式 Discovery：

```bash
pnpm e2e:discovery
```

验证 Creator PK 初始回合只调用一次真实模型，并输出 latency trace：

```bash
pnpm e2e:one-call
```

完成并保存 Ready 会话后，可在该状态的副本上验证决策变更与 Ready 失效：

```bash
pnpm e2e:ready-invalidation
```

使用真实 ModelFlare 通过完整 Route → Runtime → Provider → Turn Tool → Executor → Repository 链路验证 Creator PK Product Solution：

```bash
pnpm e2e:solution
```

## API

### API & Model Library

```bash
curl http://localhost:3000/api/providers

curl -X POST http://localhost:3000/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"Backup Relay","baseURL":"https://example.com/v1","apiKey":"...","models":["model-a","model-b"],"activeModel":"model-a"}'

curl -X POST http://localhost:3000/api/providers/<PROFILE_ID>/activate \
  -H 'content-type: application/json' \
  -d '{"model":"model-b"}'
```

还支持 `PATCH /api/providers/<PROFILE_ID>` 更新配置，以及 `DELETE /api/providers/<PROFILE_ID>` 删除非活动配置。完整 API Key 只接受写入，不会在读取响应中返回。

### Project History and File Management

```bash
curl http://localhost:3000/projects
curl -X PATCH http://localhost:3000/projects/<PROJECT_ID> \
  -H 'content-type: application/json' \
  -d '{"name":"New project name"}'
curl -OJ http://localhost:3000/projects/<PROJECT_ID>/export
```

产物清理与项目删除：

```bash
curl -X DELETE http://localhost:3000/projects/<PROJECT_ID>/artifacts/prd
curl -X DELETE http://localhost:3000/projects/<PROJECT_ID>/artifacts/interaction
curl -X DELETE http://localhost:3000/projects/<PROJECT_ID>/artifacts/figma-prompt
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/cleanup
curl -X DELETE http://localhost:3000/projects/<PROJECT_ID>
```

清理 PRD 会同时清理依赖它的 Interaction 和 Figma Prompt；清理 Interaction 会同时清理 Figma Prompt。这些接口只处理 `.runtime` 中的项目数据，不会删除 Prompt 库或源码文件。

### Create Project

```bash
curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Creator PK","initialRequirement":"我想做一个主播PK功能"}'
```

### Talk to Discovery

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/messages \
  -H 'content-type: application/json' \
  -d '{"content":"现在主播之间没有互动能力，希望增加互动，礼物流水是二级商业验证。"}'
```

### ChatGPT Manual Bridge (Experimental)

生成本轮手动 Prompt；该操作只读，不调用模型，也不保存用户消息：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/manual-bridge/prompt \
  -H 'content-type: application/json' \
  -d '{"kind":"USER_MESSAGE","content":"现在主播之间没有互动能力"}'
```

将返回的 `prompt` 复制到 ChatGPT。再把 ChatGPT 的完整返回连同生成接口返回的 Stage/版本元数据一起提交：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/manual-bridge/apply \
  -H 'content-type: application/json' \
  -d '{"stage":"DISCOVERY","kind":"USER_MESSAGE","expectedRevision":0,"expectedRecordVersion":0,"turnToken":"<生成接口返回的 turnToken>","userMessage":"现在主播之间没有互动能力","response":"<完整 ChatGPT 返回>"}'
```

服务端会确定性提取 `AI_PRODUCT_WORKFLOW_UPDATE` 块，直接用现有 Turn Schema 和 Executor 校验执行；格式无效、Stage 已变化或任一版本过期时不保存任何内容。Product Solution 的初始回合使用 `{"kind":"SOLUTION_START"}` 生成 Prompt，并同样在成功应用返回时才启动 Stage。

### Inspect State

```bash
curl http://localhost:3000/projects/<PROJECT_ID>
```

重点看：

- `productSpec.discovery`
- `productSpec.openQuestions`
- `productSpec.decisions`
- `workflow.stages.DISCOVERY`

### Confirm Discovery

只有状态为 `READY_FOR_CONFIRMATION` 才能确认：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/stages/discovery/confirm
```

### Start Product Solution

只有 Discovery 已确认且 Solution 尚未开始时才能启动：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/stages/solution/start
```

启动后继续使用同一个消息接口讨论和修改方案。服务器根据 `activeStage` 将消息交给 Product Solution Runtime。

### Confirm Product Solution

只有 Solution 状态为 `READY_FOR_CONFIRMATION` 才能确认：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/stages/solution/confirm
```

### Generate PRD Requirement Details

仅在 Discovery 和 Product Solution 都已确认、且不存在上游 Blocking Open Question 时允许生成：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/prd/generate
```

正常生成严格使用两次模型调用：PRD Meta Selection 和 PRD Generation。命中 Draft/Missing Capability 时只执行 Meta 调用并保存阻塞原因。

当 PRD Generation 按现有 Base Prompt 返回 `NEEDS_INPUT` 时，回答阻塞问题并继续生成：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/prd/clarify \
  -H 'content-type: application/json' \
  -d '{"answer":"已确认的规则或边界..."}'
```

续生成会持久化问题与回答，校验已保存的来源版本和 Total Prompt Hash，并且只执行一次 PRD Generation 调用，不重复运行 Meta。

### Edit and Confirm PRD

```bash
curl -X PATCH http://localhost:3000/projects/<PROJECT_ID>/artifacts/prd \
  -H 'content-type: application/json' \
  -d '{"content":"## Requirement Details..."}'

curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/prd/confirm
```

Discovery 或 Product Solution 的业务内容变化后，已生成 PRD 自动标记为 `STALE`，旧内容保留但不能继续编辑或确认。

### Generate, Edit, and Confirm Interaction Specification

仅在 PRD 为 `CURRENT / CONFIRMED` 时允许生成。Interaction 使用一次模型调用，不重新执行产品决策：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/interaction/generate
curl -X PATCH http://localhost:3000/projects/<PROJECT_ID>/artifacts/interaction \
  -H 'content-type: application/json' \
  -d '{"content":"## Interaction Specification..."}'
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/interaction/confirm
```

如果 Interaction 发现核心业务规则缺失，问题会回流到 Product Solution；文档级问题可通过 `/artifacts/interaction/clarify` 单次续生成。

### Assemble Codex Figma Prototype Prompt

仅在 PRD 和 Interaction Specification 均为 `CURRENT / CONFIRMED` 时允许组装：

```bash
curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/figma-prompt/generate
```

正常流程只使用一次 Figma Meta 模型调用；最终 Codex Prompt 由程序确定性组装，不再调用模型重写 Project Prompt 或 Total Prompt。

```bash
curl -X PATCH http://localhost:3000/projects/<PROJECT_ID>/artifacts/figma-prompt \
  -H 'content-type: application/json' \
  -d '{"content":"# Codex Figma Prototype Task..."}'

curl -X POST http://localhost:3000/projects/<PROJECT_ID>/artifacts/figma-prompt/confirm
```

PRD 内容变化后，Interaction 和 Figma Prompt 自动标记为 `STALE`；Interaction 内容变化后，Figma Prompt 自动标记为 `STALE`。Figma Prompt Artifact 只提供给 Codex 执行，不会在当前服务中调用 Figma。

## V0 暂不实现

- Prototype Generator
- 自动执行 Research / Technical Validation
- PostgreSQL Repository
- Streaming
- Authentication

## 下一步测试标准

用至少五类真实需求跑 Discovery：

1. Creator PK（功能型）
2. PK Launch Campaign（活动型）
3. Contribution Top3 优化（优化型）
4. PK 断线重连（规则型）
5. 提高主播互动（高度模糊型）

观察：

- 是否过早 Solutionize
- 是否重复问已知问题
- 是否把 Unknown 全丢给用户
- Product Spec 是否与对话一致
- 是否在信息足够时停止追问
- Ready 是否过早/过晚
