# Function Calling Architecture V0

## 1. Purpose

Function Calling 的作用是限制 AI 修改系统状态的方式。

LLM 不直接：

* 修改数据库；
* 修改 Workflow Status；
* Confirm Stage；
* 进入下一 Stage；
* 生成任意 Product Spec JSON；
* 静默覆盖已有 Decision。

LLM 只能通过明确 Function 提交结构化操作。

整体关系：

```text
User Message
↓
LLM
↓
Tool Call
↓
Server Validation
↓
Product Spec / Open Question / Decision
↓
Workflow Rules
↓
Updated Context
```

核心原则：

> LLM 提议状态变化，Runtime 决定是否允许执行。

---

# 2. Tool Categories

V0 分成三类能力。

## A. Model Tools

允许 Stage Runtime 调用：

```text
update_product_spec
manage_open_question
record_decision
request_validation
evaluate_stage
```

## B. Workflow Commands

由用户动作或 Workflow Engine 执行：

```text
confirm_stage
start_stage
reopen_stage
```

不暴露给 LLM。

## C. Artifact Commands

由用户或 Artifact Layer 调用：

```text
generate_prd
assemble_figma_prompt
generate_prototype_package
```

不属于 Discovery / Solution / Interaction Tool Set。

---

# 3. Shared Tool Context

每次 Function Call 不需要让模型自行传：

* projectId；
* currentStage；
* userId；
* current revision；
* permission。

Runtime 已经知道这些信息。

Tool Execution Context：

```ts
interface ToolExecutionContext {
  projectId: string
  activeStage: ReasoningStage

  productSpecRevision: number

  stageContentVersion: number
}
```

Runtime 自动注入。

这样避免模型伪造：

```text
stage = SOLUTION
```

然后越权修改 Solution。

---

# 4. update_product_spec

## Purpose

修改当前 Stage 所拥有的 Product Spec。

这是整个系统最核心的 Function。

```ts
interface UpdateProductSpecInput {
  operations: ProductSpecOperation[]

  summary: string
}
```

```ts
interface ProductSpecOperation {
  op:
    | "ADD"
    | "REPLACE"
    | "REMOVE"

  path: string

  value?: unknown

  reason?: string
}
```

示例：

```json
{
  "operations": [
    {
      "op": "REPLACE",
      "path": "discovery.problem.statement",
      "value": "主播之间缺少稳定的互动与竞争能力",
      "reason": "用户已明确当前直播产品仅支持单播"
    },
    {
      "op": "ADD",
      "path": "discovery.scope.mustSolve",
      "value": "建立主播间互动基础能力"
    }
  ],
  "summary": "更新核心问题与V1必须解决范围"
}
```

---

## Ownership Validation

Runtime 必须按照 Active Stage 限制可写 Path。

### Discovery

只允许：

```text
discovery.*
openQuestions
decisions
```

### Solution

只允许：

```text
solution.*
openQuestions
decisions
```

### Interaction

只允许：

```text
interaction.*
openQuestions
decisions
```

例如 Interaction 调用：

```text
REPLACE solution.rules[3]
```

必须直接 Reject。

返回：

```text
UPSTREAM_CHANGE_REQUIRED
```

---

## Update Validation

Server 执行前检查：

1. Path 是否存在或允许创建；
2. 当前 Stage 是否拥有该字段；
3. Value 是否符合 Product Spec Schema；
4. 是否违反 Confirmed 上游 Ownership；
5. 是否存在版本冲突；
6. 是否属于实质业务变化。

成功后：

```text
ProductSpec.revision + 1
Stage.contentVersion + 1
```

如属于实质业务变化，触发 Downstream Invalidation。

---

## Important Rule

LLM 不应一次提交巨大 Spec。

优先提交当前已经形成的增量变化。

避免：

```text
replace discovery = {...整个Discovery...}
```

优先：

```text
replace discovery.problem.statement
add discovery.scope.mustSolve
```

这样：

* 容易审计；
* 容易 diff；
* 容易判断影响范围；
* 不容易覆盖旧信息。

---

# 5. manage_open_question

原来的：

```text
create_open_question
resolve_open_question
```

我建议合并。

因为它们管理的是同一个 Domain Object。

```ts
interface ManageOpenQuestionInput {
  action:
    | "CREATE"
    | "RESOLVE"
    | "DEFER"
    | "REOPEN"

  questionId?: string

  question?: string
  impact?: string

  blocking?: boolean

  resolutionMethod?:
    | "DERIVE"
    | "DEFAULT"
    | "RESEARCH"
    | "DATA_VALIDATION"
    | "STAKEHOLDER_CONFIRMATION"
    | "TECHNICAL_VALIDATION"
    | "PRODUCT_DECISION"
    | "DEFER"

  resolution?: string
}
```

---

## CREATE

例如：

```json
{
  "action": "CREATE",
  "question": "现有直播架构是否支持Creator断线后保留Room？",
  "impact": "影响PK重连方案是否成立",
  "blocking": true,
  "resolutionMethod": "TECHNICAL_VALIDATION"
}
```

Runtime 自动写入当前 Stage。

---

## RESOLVE

```json
{
  "action": "RESOLVE",
  "questionId": "oq_123",
  "resolution": "现有LIVE断线即关闭Room，因此V1不继承原Room重连"
}
```

注意：

**Resolve Open Question ≠ 自动修改 Product Spec。**

如果 Resolution 导致产品事实变化，LLM 还需要调用：

```text
update_product_spec
```

这样系统能明确区分：

```text
问题被回答
```

和：

```text
产品定义被修改
```

---

# 6. record_decision

## Purpose

记录已经真正形成的重要产品决策。

不是记录普通事实。

```ts
interface RecordDecisionInput {
  decision: string

  rationale: string[]

  affectedPaths: string[]

  supersedesDecisionId?: string
}
```

例如：

```json
{
  "decision": "V1仅支持指定Creator PK，不支持Match PK",
  "rationale": [
    "当前在线主播池规模有限",
    "Match无法保证稳定匹配体验",
    "Invite PK已能验证核心互动价值"
  ],
  "affectedPaths": [
    "solution.capabilities",
    "solution.flows",
    "solution.scope"
  ]
}
```

---

## Decision vs Product Spec

Decision Log 保存：

> 为什么这么定。

Product Spec 保存：

> 当前是什么。

所以一次重要决策通常可能发生：

```text
record_decision
+
update_product_spec
```

例如：

```text
Decision:
V1不支持Match PK

Product Spec:
solution.scope.outOfScope += Match PK
```

两者不能互相代替。

---

## Decision Supersede

如果已有：

```text
Decision D12:
V1支持Match PK
```

后来修改：

```text
V1不支持Match PK
```

禁止覆盖 D12。

应该：

```text
D12 → SUPERSEDED
D18 → ACTIVE
```

新 Decision：

```json
{
  "decision": "V1取消Match PK，仅保留指定邀请",
  "rationale": ["..."],
  "affectedPaths": ["solution.capabilities"],
  "supersedesDecisionId": "D12"
}
```

这对以后 Debug 很重要。

---

# 7. request_validation

## Purpose

当问题不应该由用户拍脑袋决定时，明确创建验证请求。

统一处理：

* Research；
* Data Validation；
* Stakeholder Confirmation；
* Technical Validation。

```ts
interface RequestValidationInput {
  type:
    | "RESEARCH"
    | "DATA"
    | "STAKEHOLDER"
    | "TECHNICAL"

  question: string

  reason: string

  blocking: boolean

  relatedOpenQuestionId?: string

  expectedOutput?: string
}
```

例如：

```json
{
  "type": "RESEARCH",
  "question": "中小型直播平台的PK是否普遍依赖Connection能力？",
  "reason": "影响PK和Creator Connection的产品模型关系",
  "blocking": false,
  "relatedOpenQuestionId": "oq_21",
  "expectedOutput": "核心模式、适用条件和对当前产品的启示"
}
```

---

## V0 Important Limitation

`request_validation` 在 V0 可以先只：

```text
创建 Validation Task
```

不一定真的自动执行 Research。

第一版甚至可以显示：

```text
Technical Validation Required
```

由用户回来填写结果。

后续再接：

```text
Web Research
Internal Data
GitHub / Technical Context
Stakeholder Workflow
```

所以 Function Interface 可以先定，Execution Capability 后补。

---

# 8. evaluate_stage

## Purpose

判断当前 Stage 是否满足 Exit Criteria。

它不负责修改产品事实。

```ts
interface EvaluateStageInput {
  criteria: StageCriterionEvaluation[]

  blockingUnknownIds: string[]

  summary: string
}
```

```ts
interface StageCriterionEvaluation {
  criterionId: string

  status:
    | "SUFFICIENT"
    | "PARTIAL"
    | "MISSING"
    | "NOT_APPLICABLE"

  reason: string
}
```

例如 Discovery：

```json
{
  "criteria": [
    {
      "criterionId": "problem_clarity",
      "status": "SUFFICIENT",
      "reason": "核心问题已经明确为主播间缺乏互动与竞争能力"
    },
    {
      "criterionId": "scope_clarity",
      "status": "SUFFICIENT",
      "reason": "V1范围已经明确"
    }
  ],
  "blockingUnknownIds": [],
  "summary": "Discovery已足以进入Solution Design"
}
```

---

# 9. evaluate_stage Must Not Be Fully Trusted

这里要非常严格。

不能让 LLM：

```text
evaluate_stage(result = READY)
```

然后 Runtime 无条件接受。

Runtime 必须自己检查：

```text
criteria completeness
blocking Open Questions
dependency state
content version
schema validity
```

所以最终结果：

```text
LLM Evaluation
↓
Runtime Validation
↓
READY / NOT_READY
```

模型只能提供：

> semantic judgment

代码负责：

> deterministic rules

---

# 10. Ready Execution

如果 Runtime 判断 Ready：

```text
Stage
IN_PROGRESS
→ READY_FOR_CONFIRMATION
```

同时记录：

```text
evaluatedContentVersion
dependencySnapshot
```

AI 无法执行：

```text
CONFIRMED
```

---

# 11. Why transition_stage Should Be Removed

之前我们考虑：

```text
transition_stage
```

我建议从 Model Tools 中彻底移除。

因为 Stage Transition 是：

> Workflow Authority

不是：

> AI Reasoning Capability

如果模型可以调用：

```text
transition_stage("SOLUTION")
```

那我们前面设计：

```text
READY_FOR_CONFIRMATION
User Confirmation
Dependency Check
```

都失去意义。

正确流程：

```text
AI:
evaluate_stage()
↓
Runtime:
READY_FOR_CONFIRMATION
↓
User:
Confirm
↓
Runtime:
CONFIRMED
↓
User:
Continue
↓
Runtime:
start_stage(SOLUTION)
```

整个过程不需要 LLM 决定 Transition。

---

# 12. Why generate_artifact Should Be Removed

同理：

```text
generate_artifact
```

不应该属于 Stage Agent。

Reasoning Stage Agent 不应该突然：

> “我觉得信息够了，我帮你生成PRD。”

Artifact 是用户动作。

例如：

```text
Generate PRD
Assemble Codex Figma Prompt
Generate Prototype Package
Regenerate
```

Artifact Service 检查：

```text
Generate PRD:
Discovery = CONFIRMED
Solution = CONFIRMED

Generate Prototype Package:
PRD = CONFIRMED
Interaction = CONFIRMED

Assemble Codex Figma Prompt:
PRD = CURRENT / CONFIRMED
```

然后生成。

因此 Tool Catalog 不需要：

```text
generate_artifact
```

至少不提供给 Reasoning LLM。

---

# 13. Upstream Issue

我不建议额外创建：

```text
create_upstream_issue
```

V0 可以直接复用：

```text
manage_open_question
```

例如 Interaction 发现：

> Connected状态是否允许收到Invite未定义。

创建：

```json
{
  "action": "CREATE",
  "question": "Connected状态是否允许接收新的Creator Invitation？",
  "impact": "无法确定Connected状态下Invitation Entry的Availability",
  "blocking": true,
  "resolutionMethod": "PRODUCT_DECISION"
}
```

同时 Runtime Metadata：

```text
targetStage = SOLUTION
```

如果需要，可以给 `OpenQuestion` 增加：

```ts
ownerStage?: ReasoningStage
```

例如：

```text
createdInStage = INTERACTION
ownerStage = SOLUTION
```

Runtime 看到：

```text
ownerStage < activeStage
```

即可触发：

```text
Solution → NEEDS_REVIEW
Interaction → BLOCKED
```

不必创造一个新的 Domain Object。

---

# 14. Tool Execution Response

每个 Tool 不只返回：

```text
success
```

应该返回 Runtime 结果。

统一：

```ts
interface ToolResult {
  success: boolean

  productSpecRevision: number

  stageContentVersion: number

  workflowEffects?: WorkflowEffect[]

  errors?: ToolError[]
}
```

例如：

```json
{
  "success": true,
  "productSpecRevision": 24,
  "stageContentVersion": 7,
  "workflowEffects": [
    {
      "type": "DOWNSTREAM_INVALIDATED",
      "stage": "INTERACTION"
    },
    {
      "type": "ARTIFACT_STALE",
      "artifact": "PRD"
    }
  ]
}
```

LLM 下一轮就知道：

> 我刚刚的修改让 Interaction 需要 Review。

---

# 15. Server-side Validation

所有 Function Call 都必须先经过 Server Validation。

LLM 永远不可信任到可以直接写状态。

至少检查：

### Schema Validation

输入是否符合 Function Schema。

### Stage Permission

当前 Stage 是否有权执行。

### Field Ownership

当前 Stage 是否有权修改目标 Product Spec Path。

### Version Check

调用是否基于最新版本。

### Business State

例如：

```text
Stage = CONFIRMED
```

此时普通模型调用不能继续写入。

必须先由用户 Reopen。

### Referential Integrity

例如：

```text
scenario.actorId
```

必须引用存在的 Actor。

### Transition Rules

Tool 造成的 Workflow Effect 是否符合 State Machine。

---

# 16. Atomic Execution

一次 Tool Call 中的 `operations` 应该事务化。

例如：

```text
ADD capability
ADD flow
REPLACE scope
```

要么全部成功：

```text
COMMIT
```

要么全部失败：

```text
ROLLBACK
```

不要出现：

```text
Capability写成功
Flow失败
Scope没执行
```

然后 Product Spec 进入半完成状态。

PostgreSQL 正好适合处理这个。

---

# 17. Tool Calling Pattern

一轮正常对话可能是：

```text
User:
我们先不做Match PK，因为主播池太小。
```

LLM 判断后调用：

### 1

```text
record_decision
```

记录：

```text
V1不支持Match PK
```

### 2

```text
update_product_spec
```

修改：

```text
solution.scope.outOfScope
solution.capabilities
```

### 3

如果相关 Question 存在：

```text
manage_open_question(RESOLVE)
```

### 4

需要时：

```text
evaluate_stage
```

然后才向用户输出自然语言：

> 已收敛为 V1 仅支持 Invite PK，Match PK 延后。目前核心模型不再依赖匹配能力……

这才是：

```text
Conversation
→ Structured State
→ Human-readable Response
```

而不是反过来。

---

# 18. Tool Calling Order

V0 建议使用：

```text
Decision
↓
Product Spec Update
↓
Open Question Update
↓
Ready Evaluation
↓
User Response
```

并非每轮必须全部执行。

例如普通信息补充：

```text
update_product_spec
↓
Response
```

即可。

---

# 19. Avoid Tool Spam

不要因为 Function 存在，就每句话都调用。

例如用户说：

> 我觉得这个方向不错。

如果没有产生新的 Product Fact 或 Decision：

```text
无需 Tool Call
```

用户说：

> 那V1确定不做Match PK。

才应该：

```text
record_decision
update_product_spec
```

Function 应对应：

> state-changing event

而不是普通 Conversation。

---

# 20. Final Model Tool Set

最终 V0 Model Tools：

```text
┌───────────────────────────┐
│ update_product_spec       │
│                           │
│ 修改当前Stage产品事实     │
├───────────────────────────┤
│ manage_open_question      │
│                           │
│ 管理关键未知              │
├───────────────────────────┤
│ record_decision           │
│                           │
│ 记录产品决策及依据        │
├───────────────────────────┤
│ request_validation        │
│                           │
│ 请求外部验证              │
├───────────────────────────┤
│ evaluate_stage            │
│                           │
│ 评估当前Stage是否Ready    │
└───────────────────────────┘
```

Runtime Commands：

```text
confirm_stage
start_stage
reopen_stage
```

Artifact Commands：

```text
generate_prd
generate_prototype_package
```

因此职责非常明确：

```text
LLM
负责理解与提议

Functions
负责结构化修改

Product Spec
负责产品事实

Workflow Engine
负责状态和权限

User
负责最终确认

Artifact Generator
负责输出文档与原型包
```

## V0 Core Rule

> **凡是产品事实发生变化，必须经过 Function；凡是 Workflow 权限发生变化，不能由 LLM Function 决定。**
