# Workflow State Machine V0

## 1. Purpose

Workflow State Machine 负责回答：

* 当前正在处理哪个 Stage；
* 每个 Stage 当前处于什么状态；
* AI 是否认为当前 Stage 已经足够；
* 用户是否已经确认；
* 下一 Stage 是否允许开始；
* 上游结论变化后，哪些下游内容需要重新检查；
* Product Spec 与 Artifact 是否仍然有效。

Workflow State 不保存产品事实。

Product Spec 回答：

> 产品现在是什么。

Workflow State 回答：

> 产品设计现在做到哪里。

---

## 2. Workflow Structure

V0 将 Workflow 分为两类。

### Reasoning Stages

```text
Discovery
→ Solution
→ Interaction
```

这些 Stage 会持续：

* 与用户讨论；
* 修改 Product Spec；
* 处理 Open Question；
* 记录 Decision；
* 判断 Ready。

### Artifact Generation

```text
PRD
Prototype Package
```

它们不属于 Reasoning Stage。

它们读取已确认的 Product Spec 生成 Artifact，不参与产品事实决策。

因此：

```text
Discovery
    ↓ Confirmed
Solution
    ↓ Confirmed
PRD Requirement Details
    ↓ User Review & Confirm
Interaction
    ↓ Confirmed
Prototype Package
```

---

# 3. Stage Status

```ts
type StageStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "READY_FOR_CONFIRMATION"
  | "CONFIRMED"
  | "NEEDS_REVIEW"
  | "BLOCKED"
```

### NOT_STARTED

Stage 尚未开始。

不代表存在问题。

可能只是：

* 前置 Stage 尚未完成；
* 用户尚未进入该 Stage。

---

### IN_PROGRESS

Stage 正在工作。

允许：

* Conversation；
* Product Spec Update；
* Decision；
* Open Question；
* Research / Validation；
* Ready Evaluation。

---

### READY_FOR_CONFIRMATION

AI 已判断当前 Stage 满足 Exit Criteria。

但用户尚未确认。

此时：

* AI 不继续制造问题；
* AI 不自动进入下一 Stage；
* 用户可以确认；
* 用户也可以继续修改。

如果 Product Spec 再发生实质变化：

```text
READY_FOR_CONFIRMATION
→ IN_PROGRESS
```

原 Ready Evaluation 失效。

---

### CONFIRMED

用户明确确认当前 Stage。

表示：

> 当前版本可以作为下游 Stage 的有效输入。

只有 `CONFIRMED` 才能解锁直接下游。

AI 无权自行将 Stage 设置为 CONFIRMED。

---

### NEEDS_REVIEW

该 Stage 曾经存在有效内容，但其依赖的上游信息后来发生变化。

例如：

```text
Discovery CONFIRMED
Solution CONFIRMED
Interaction CONFIRMED
```

用户修改 Discovery：

```text
Discovery → IN_PROGRESS
Solution → NEEDS_REVIEW
Interaction → NEEDS_REVIEW
```

`NEEDS_REVIEW` 表示：

> 原方案不能继续被当作已确认事实，但也不应直接删除。

用户需要重新检查。

---

### BLOCKED

Stage 当前无法继续工作。

用于明确的外部阻塞，例如：

* 上游 Stage 存在未解决问题；
* Interaction 发现 Solution 缺失关键 Business Rule；
* 必须等待 Technical / Stakeholder Validation；
* 当前输入存在无法继续处理的 Conflict。

BLOCKED 不用于普通 Unknown。

如果系统仍然可以通过讨论解决问题，应保持 `IN_PROGRESS`。

---

# 4. Active Stage

Workflow 单独维护：

```ts
type ReasoningStage =
  | "DISCOVERY"
  | "SOLUTION"
  | "INTERACTION"
```

```ts
interface WorkflowState {
  activeStage: ReasoningStage | null
  stages: Record<ReasoningStage, StageRuntimeState>
  artifacts: ArtifactRuntimeState
}
```

`activeStage` 表示：

> 当前允许修改哪个 Stage。

查看历史 Stage 不会改变 Active Stage。

用户只有真正选择：

> “我要修改 Discovery。”

才执行 Reopen。

---

# 5. Stage Runtime State

```ts
interface StageRuntimeState {
  status: StageStatus

  contentVersion: number

  confirmedVersion?: number

  readyEvaluation?: ReadyEvaluation

  dependencySnapshot?: Partial<
    Record<ReasoningStage, number>
  >

  blockingIssues: string[]

  updatedAt: string
}
```

---

## contentVersion

当前 Stage 所拥有的 Product Spec 内容每次发生实质变化：

```text
contentVersion + 1
```

例如：

```text
Discovery v4
→ 修改目标用户
→ Discovery v5
```

日志、聊天和纯文案修改不增加 Stage Content Version。

---

## confirmedVersion

用户最近一次确认时的 `contentVersion`。

例如：

```text
contentVersion = 7
confirmedVersion = 7
status = CONFIRMED
```

之后重新修改：

```text
contentVersion = 8
confirmedVersion = 7
status = IN_PROGRESS
```

说明当前版本已经不同于上次确认版本。

---

# 6. Stage Dependencies

固定 Dependency Graph：

```text
Discovery
    ↓
Solution
    ↓
Interaction
```

因此：

```ts
const dependencies = {
  DISCOVERY: [],
  SOLUTION: ["DISCOVERY"],
  INTERACTION: ["DISCOVERY", "SOLUTION"]
}
```

V0 不支持自定义 Workflow DAG。

---

# 7. Stage Start Rule

### Discovery

可以直接：

```text
NOT_STARTED
→ IN_PROGRESS
```

### Solution

只有：

```text
Discovery = CONFIRMED
```

才能开始。

### Interaction

只有：

```text
Discovery = CONFIRMED
Solution = CONFIRMED
```

才能开始。

AI 无权绕过依赖条件。

---

# 8. Ready Evaluation

`evaluate_stage` 只负责判断：

> 当前 Stage 是否满足 Exit Criteria。

不负责：

* Confirm；
* Transition；
* Start Next Stage。

结构概念：

```ts
interface ReadyEvaluation {
  criteria: Record<
    string,
    "SUFFICIENT"
    | "PARTIAL"
    | "MISSING"
    | "NOT_APPLICABLE"
  >

  blockingUnknownCount: number

  result:
    | "READY"
    | "NOT_READY"

  evaluatedContentVersion: number

  dependencySnapshot: Partial<
    Record<ReasoningStage, number>
  >
}
```

---

## Ready 条件

Stage Spec 自己定义 Criteria。

Workflow Engine 统一检查：

```text
所有必要 Criteria
= SUFFICIENT / NOT_APPLICABLE

AND

blockingUnknownCount = 0

AND

所有 Dependency = CONFIRMED
```

满足：

```text
IN_PROGRESS
→ READY_FOR_CONFIRMATION
```

---

# 9. Ready Evaluation Freshness

Ready Evaluation 只对它评估时的 Product Spec 有效。

例如：

```text
Interaction v12
evaluate_stage()
→ READY
```

用户又修改：

```text
Interaction v13
```

则自动：

```text
READY_FOR_CONFIRMATION
→ IN_PROGRESS
```

原 Ready Evaluation 作废。

同样，如果 Dependency Version 变化，Ready Evaluation 立即失效。

---

# 10. User Confirmation

只有用户显式动作才能执行：

```text
READY_FOR_CONFIRMATION
→ CONFIRMED
```

确认时 Runtime 必须再次检查：

* Ready Evaluation 仍然有效；
* `contentVersion` 没变化；
* Dependency Snapshot 没变化；
* 没有 Blocking Issue。

确认成功后：

```text
confirmedVersion = contentVersion
```

并保存当前 Dependency Snapshot。

---

# 11. Confirmation ≠ Automatic Transition

Stage Confirmed 后：

```text
Discovery = CONFIRMED
Solution = NOT_STARTED
```

系统只解锁 Solution。

不会自动：

```text
activeStage = SOLUTION
```

用户执行：

> 进入 Product Solution。

才：

```text
Solution
NOT_STARTED → IN_PROGRESS

activeStage = SOLUTION
```

UI 将来可以把：

> Confirm & Continue

做成一个按钮。

但内部仍然是两个 Event：

```text
CONFIRM_STAGE
START_NEXT_STAGE
```

避免把两个状态变化绑死。

---

# 12. Reopen Stage

用户可以返回已经 Confirmed 的 Stage。

例如：

```text
Discovery = CONFIRMED
Solution = CONFIRMED
Interaction = IN_PROGRESS
```

用户选择：

> 修改 Discovery。

执行：

```text
Discovery
CONFIRMED → IN_PROGRESS

activeStage = DISCOVERY
```

仅“打开查看”不会 Reopen。

---

# 13. Downstream Invalidation

这是 V0 最关键的规则之一。

当上游 Stage 的 Product Spec 发生**实质变化**时，所有已有下游结果立即失去 Confirmed 资格。

### Discovery Change

```text
Discovery → IN_PROGRESS

Solution:
如果已有内容 → NEEDS_REVIEW

Interaction:
如果已有内容 → NEEDS_REVIEW
```

### Solution Change

```text
Solution → IN_PROGRESS

Interaction:
如果已有内容 → NEEDS_REVIEW
```

### Interaction Change

不会影响 Reasoning Stage。

但会影响 Artifact。

---

# 14. Do Not Delete Downstream Content

上游变化时禁止直接删除下游 Product Spec。

例如：

```text
Discovery:
Primary User
Creator
→ Creator + Agency
```

不能：

```text
delete ProductSpec.solution
delete ProductSpec.interaction
```

应该：

```text
Solution = NEEDS_REVIEW
Interaction = NEEDS_REVIEW
```

保留旧内容作为 Review 基础。

这样 AI 可以判断：

* 哪些仍然成立；
* 哪些需要修改；
* 哪些已经失效。

---

# 15. Review Flow

上游重新 Confirmed 后，下游不会自动恢复 CONFIRMED。

例如：

```text
Discovery = CONFIRMED
Solution = NEEDS_REVIEW
```

用户进入 Solution：

```text
NEEDS_REVIEW
→ IN_PROGRESS
```

AI 对比：

```text
Old Solution
vs
New Discovery
```

然后：

* 修改受影响部分；
* 保留未受影响部分；
* 重新 evaluate_stage。

最终：

```text
IN_PROGRESS
→ READY_FOR_CONFIRMATION
→ User Confirm
→ CONFIRMED
```

禁止自动重新 Confirm。

---

# 16. Upstream Issue

下游 Stage 如果发现上游缺失关键定义：

例如 Interaction 发现：

> PK Connected 状态到底允不允许再次接受邀请没有定义。

这是 Business Rule，不属于 Interaction。

Interaction 创建：

```text
UPSTREAM_ISSUE
targetStage = SOLUTION
```

然后：

```text
Solution:
CONFIRMED → NEEDS_REVIEW

Interaction:
IN_PROGRESS → BLOCKED
```

用户返回 Solution 解决。

Solution 再次 CONFIRMED 后：

```text
Interaction:
BLOCKED → NEEDS_REVIEW
```

用户重新进入 Interaction：

```text
NEEDS_REVIEW → IN_PROGRESS
```

---

# 17. Blocking Unknown

普通 Blocking Unknown 不一定意味着 Stage = BLOCKED。

例如：

> 用户还没确定 V1 是否支持 Match PK。

如果当前可以继续通过 Product Decision 讨论：

```text
Solution = IN_PROGRESS
```

只有问题需要等待外部事件且当前无法继续时，例如：

> 必须等待研发确认现有直播架构是否支持双流合并。

才可以：

```text
Solution = BLOCKED
```

---

# 18. Artifact State

PRD、Codex Figma Prompt 和 Prototype Package 使用独立状态。

```ts
type ArtifactStatus =
  | "NOT_GENERATED"
  | "CURRENT"
  | "STALE"
  | "FAILED"
```

```ts
interface ArtifactState {
  status: ArtifactStatus

  sourceVersions?: {
    discovery: number
    solution: number
    interaction?: number
  }

  generatedAt?: string
}
```

---

# 19. Artifact Eligibility

PRD Requirement Details 只有在：

```text
Discovery = CONFIRMED
Solution = CONFIRMED
```

且不存在 Discovery / Solution Blocking Issue 时才能生成。

Codex Figma Prompt 只有在：

```text
PRD = CURRENT / CONFIRMED
```

时才能组装。它是供 Codex 执行的 Prompt Artifact，不是已经完成的 Figma Prototype，也不调用 Figma。当前实现直接读取确认后的 PRD；未来 Interaction Specification 可用时，应作为附加来源重新组装并记录对应版本。

Prototype Package 只有在：

```text
Discovery = CONFIRMED
Solution = CONFIRMED
PRD = CONFIRMED
Interaction = CONFIRMED
```

时才能生成。PRD 是 Interaction 的输入 Artifact，不是 Reasoning Stage。

---

# 20. Artifact Staleness

Artifact 保存生成时的：

```text
PRD: Discovery Version + Solution Version
Codex Figma Prompt: Discovery Version + Solution Version + PRD Content Version
Prototype: Discovery Version + Solution Version + Interaction Version
```

如果任何相关 Stage 后续发生实质变化：

```text
CURRENT → STALE
```

例如：

```text
PRD
source:
Discovery 5
Solution 8
```

随后：

```text
Solution 8 → 9
```

则：

```text
PRD = STALE
Prototype Package = STALE
```

旧 Artifact 不删除。

用户可以查看，但 UI 必须明确提示：

> 当前 Artifact 基于旧版本 Product Spec。

---

# 21. Invalidations by Stage

V0 使用确定性 Dependency Rule，不让 LLM 自由判断是否需要失效。

```text
Discovery changed
→ Solution NEEDS_REVIEW
→ Interaction NEEDS_REVIEW
→ PRD STALE
→ Prototype STALE
```

```text
Solution changed
→ Interaction NEEDS_REVIEW
→ PRD STALE
→ Codex Figma Prompt STALE
→ Prototype STALE
```

```text
Interaction changed
→ Prototype STALE
```

V0 暂时不做字段级智能 Dependency Graph。

先保证可预测和可 Debug。

---

# 22. Non-business Changes

以下修改不触发下游失效：

* 修改聊天内容；
* 修改 Decision 的说明文案但 Decision 本身没变；
* 补充不影响结论的 Evidence；
* 修改 Artifact 排版；
* 修改 Project Name；
* UI 展示配置。

只有 Canonical Product Spec 的业务含义发生变化，才产生 Stage Content Version。

---

# 23. Allowed Stage Transitions

```text
NOT_STARTED
→ IN_PROGRESS
```

```text
IN_PROGRESS
→ READY_FOR_CONFIRMATION
→ CONFIRMED
```

```text
READY_FOR_CONFIRMATION
→ IN_PROGRESS
```

```text
CONFIRMED
→ IN_PROGRESS
```

用户主动修改当前 Stage。

```text
CONFIRMED
→ NEEDS_REVIEW
```

上游变化。

```text
NEEDS_REVIEW
→ IN_PROGRESS
```

用户重新处理。

```text
IN_PROGRESS
→ BLOCKED
```

出现当前无法继续的外部阻塞。

```text
BLOCKED
→ IN_PROGRESS
```

原阻塞解决且无需上游 Review。

或：

```text
BLOCKED
→ NEEDS_REVIEW
```

上游发生变化，需要重新检查。

其他 Transition 默认禁止。

---

# 24. Workflow Example

初始：

```text
Discovery     NOT_STARTED
Solution      NOT_STARTED
Interaction   NOT_STARTED
```

用户开始：

```text
Discovery     IN_PROGRESS
```

AI 判断信息足够：

```text
Discovery     READY_FOR_CONFIRMATION
```

用户确认：

```text
Discovery     CONFIRMED
Solution      NOT_STARTED
```

用户进入 Solution：

```text
Solution      IN_PROGRESS
```

完成后：

```text
Discovery     CONFIRMED
Solution      CONFIRMED
Interaction   NOT_STARTED
```

生成并确认 PRD：

```text
PRD           CURRENT / CONFIRMED
Interaction   NOT_STARTED
```

Interaction 完成：

```text
Discovery     CONFIRMED
Solution      CONFIRMED
Interaction   CONFIRMED
```

现在：

```text
Prototype Package unlocked
```

之后用户修改 Discovery：

```text
Discovery     IN_PROGRESS
Solution      NEEDS_REVIEW
Interaction   NEEDS_REVIEW

PRD           STALE
Prototype     STALE
```

整个系统不会假装旧方案仍然有效。

---

# 25. Core Invariants

V0 必须始终满足：

```text
AI can evaluate Ready
≠
AI can Confirm
```

```text
Stage Confirmed
≠
Automatically start next Stage
```

```text
View previous Stage
≠
Reopen previous Stage
```

```text
Upstream change
≠
Delete downstream content
```

```text
Upstream change
→
Invalidate downstream confirmation
```

```text
Artifact
≠
Source of Truth
```

```text
Product Spec
=
Source of Truth
```

```text
Workflow State
=
Validity + Progress Control
```

---

# 26. V0 Final Model

```text
                 Product Spec
                      │
               business change
                      ↓
              Workflow Engine
                      │
        ┌─────────────┼─────────────┐
        ↓             ↓             ↓
    Discovery      Solution     Interaction
        │             │             │
     Confirm        Confirm        Confirm
        └─────────────┴─────────────┘
                      ↓
              Artifact Eligible
                 ┌────┴────┐
                 ↓         ↓
                PRD     Prototype
```

核心设计原则只有一句：

> **AI负责判断，用户负责批准，Workflow Engine负责保证状态一致性。**
