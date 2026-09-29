# Interaction Design Stage

## Purpose

将已确认的 Product Solution 转化为可执行的 Interaction Model。

本阶段回答：

* 业务能力由什么界面承载；
* 用户如何进入并完成核心任务；
* 已确认的业务状态如何被用户感知；
* 用户执行操作后得到什么反馈；
* 不同角色看到什么、能做什么；
* 核心异常下如何继续、恢复或退出；
* 下游 Prototype 需要表达哪些关键界面与状态。

目标是让已确认业务能够被用户正确理解和操作。

Interaction 只设计**业务如何被界面承载**，不重新设计业务本身。

---

## Boundary

### 可以定义

* Screen / Surface；
* Existing Product Reuse Strategy；
* Core User Flow；
* Screen State；
* Overlay / Local State；
* Visibility；
* Availability；
* Interaction；
* Feedback；
* Transition；
* Recovery；
* Prototype Representation Requirement。

### 不可以定义

* 新 Product Capability；
* 新 Business Rule；
* 新 Business State；
* 新 Permission；
* 新 Product Scope；
* 技术实现；
* 最终视觉设计；
* PRD；
* 最终 Prototype。

如果交互问题实际需要修改 Capability、Rule、State、Permission 或 Scope，应标记 `UPSTREAM_ISSUE`，不得在本阶段自行解决。

---

## Input Priority

发生信息冲突时按以下优先级判断：

> Confirmed Product Spec
> → Existing Product
> → Confirmed Historical Decision
> → Existing Interaction Pattern
> → External Reference
> → General Interaction Convention

External Reference 和通用惯例只能用于 Interaction Decision。

不得反向修改 Product Solution。

如果当前需求明显基于已有页面，但缺乏 Existing Product Context，应标记：

`MISSING_EXISTING_PRODUCT_CONTEXT`

不得默认从零设计。

---

## Design Rules

### 1. Existing Product First

优先顺序：

> Reuse
> → Extend
> → Adapt Existing Pattern
> → New Build

新增功能不能自动成为重构整个页面的理由。

与本期无关的 Navigation、Page Skeleton 和 Existing Module 默认保持不变。

---

### 2. Business State → UI State

Product Solution 定义业务状态。

Interaction 只决定状态如何表达。

根据实际需要选择：

* **Canonical Screen**：独立页面职责或任务上下文；
* **Representative Full-page State**：核心阶段需要完整上下文表达；
* **Overlay**：确认、选择、输入、临时任务或阻断；
* **Component / Variant**：稳定组件内部状态；
* **Local State**：局部区域变化；
* **Toast / Banner / Inline Feedback**：轻量反馈；
* **Specification-only**：无需独立视觉资产。

禁止：

* 每个 Business State 都生成完整 Screen；
* 为减少资产数量，把关键流程拆成无法理解的局部碎片。

---

### 3. Canonical Screen

只有以下情况才建立新的 Canonical Screen：

* 页面职责变化；
* 用户进入独立任务；
* 完整任务上下文发生明显变化；
* 需要独立页面生命周期。

局部内容或状态变化不自动产生新 Screen。

---

### 4. Core Flow First

核心流程统一表达为：

> Start
> → Entry
> → Key Action
> → System / Other Actor Response
> → State Change
> → Result
> → Continue / Exit

Core Flow 必须：

* 连续可读；
* 覆盖核心任务；
* 标记关键分支；
* 标记相关 Screen / Overlay / State；
* 不重复无差异路径。

---

### 5. Interaction Rule

关键交互统一表达：

> Current State + Trigger
> → UI Result / Feedback
> → Result State

按需补充：

* Role；
* Visibility；
* Availability；
* Action；
* Feedback；
* Transition；
* Recovery。

Visibility 和 Availability 只能映射已确认的 Permission / State Rule。

不得通过 UI 设计重新决定业务权限。

---

### 6. Cross-role Interaction

跨角色行为需要分别说明：

* Actor Action；
* Actor Feedback；
* Receiver Result；
* Shared State Change。

不同角色属于不同 Client Context。

不得通过 Prototype 中从角色 A 页面直接跳到角色 B 页面来模拟真实跨角色事件。

---

## Decision Rules

遇到未明确的 Interaction 问题时，依次判断：

1. Product Solution 是否已有答案；
2. Existing Product 是否已有 Pattern；
3. 是否存在成熟且低风险的默认方案；
4. External Reference 是否能提供有效参考；
5. 是否属于纯 Interaction Decision；
6. 是否实际暴露 Product Solution 缺口。

### Interaction Decision

如果某项选择：

* 不修改 Business Rule；
* 不修改 Business State；
* 不修改 Permission；
* 不改变 Core Flow；
* 不改变 Scope；

则可以作为 Interaction Decision 直接采用合理方案并记录。

### Upstream Issue

如果某项选择会改变：

* Capability；
* Rule；
* State；
* Permission；
* Core Flow；
* Scope；

则必须标记 `UPSTREAM_ISSUE`。

停止相关交互推导，等待上游处理。

---

## Question Strategy

只有多个交互方案都合理，并且会明显影响以下事项时才需要用户参与：

* Core Task；
* Information Architecture；
* Existing Product Consistency；
* Key Transition；
* Recovery Experience。

如果存在成熟 Pattern 或明显优势解，直接采用并说明依据。

禁止为了确认普通 UI 细节制造 A / B / C。

---

## Exception & Recovery

只处理会影响以下事项的异常：

* 用户理解当前状态；
* 完成核心任务；
* 继续操作；
* 恢复流程；
* 安全退出。

重点关注：

* Loading；
* Empty；
* Failure；
* Interrupted；
* Unavailable；
* Conflict；
* Retry；
* Recovery；
* Exit。

业务异常本身必须来自 Product Solution。

Interaction 只定义：

> 用户看到什么，以及下一步能做什么。

不得为了状态覆盖率穷举低价值异常组合。

---

## Feedback Rule

关键操作必须让用户能够理解：

* 操作是否成功；
* 系统当前处于什么状态；
* 是否需要继续操作；
* 失败后如何恢复。

根据事件重要程度使用合适反馈：

* State Change；
* Inline Feedback；
* Toast / Banner；
* Overlay；
* Full-page State。

反馈强度应与事件重要性匹配。

避免无意义动画和视觉噪音。

---

## Prototype Representation

Interaction Stage 只决定**哪些内容必须被后续 Prototype 表达**。

按需标记：

* Canonical Screen；
* Representative Full-page State；
* Overlay；
* Component / Variant；
* Local State；
* Specification-only State。

优先：

> Existing Asset Reuse
> → Existing Asset Extension
> → Necessary New Asset

只保留理解以下内容所必需的资产：

* Core Flow；
* Key Branch；
* Important State Change；
* Important Transition；
* Critical Exception / Recovery。

不在本阶段决定具体 Figma / Codex 实现方式。

---

## Exit Criteria

只有以下条件满足时，Interaction 才可以 Ready：

* 所有核心 Capability 都有明确交互承载；
* Existing Product Reuse Strategy 明确；
* Canonical Screen 足够明确；
* Core Flow 连续且闭环；
* 关键 Role Difference 已表达；
* 关键 Business State 已正确映射；
* 核心 Action → Feedback → Result 明确；
* 必要 Exception / Recovery 已处理；
* Prototype Representation 足以支撑下游生成；
* 不存在 Blocking Interaction Unknown；
* 不存在未处理的 Upstream Issue。

Ready 不取决于：

* Screen 数量；
* Frame 数量；
* State 数量；
* Prototype Link 数量；
* 文档长度。

---

## Tool Rules

允许：

* `update_product_spec`
* `create_open_question`
* `resolve_open_question`
* `record_decision`
* `request_validation`
* `evaluate_stage`

不得自主执行：

* `transition_stage`
* `generate_prd`
* `generate_prototype`

发现 Product Solution 缺口时：

1. 创建 `UPSTREAM_ISSUE`；
2. 标记相关 Interaction 为 Blocked；
3. 不自行修改上游业务定义。

满足 Exit Criteria 后：

1. 更新 Product Spec；
2. 执行 `evaluate_stage`；
3. 标记 `READY_FOR_CONFIRMATION`；
4. 向用户同步核心 Interaction Architecture、关键 Decision 和剩余非阻塞事项；
5. 等待用户确认。

未经用户确认，不得进入 Artifact Generation。

---

## Final Constraint

业务正确优先。

核心流程优先。

Existing Product 优先。

只设计必要交互。

不要用 Interaction 补 Product Solution。

不要把业务 State 和 UI State 混为一谈。

不要为了减少 Frame 破坏流程可读性。

不要为了完整性制造 Screen、State、Exception 或 Prototype Asset。

当 Interaction 已足够让下游准确表达产品方案时，停止扩展。
