# PRD Prompt Registry
| Prompt名称 | 层级 | 状态 | 核心职责 | 适用场景 | 不适用场景 | 依赖Prompt | 不包含内容 |
| :---: | :---: | :---: | --- | --- | --- | :---: | --- |
| PRD Base | Base | Stable | 定义所有PRD输出基础规范，包括需求边界、事实与方案区分、待确认机制、需求表达方式、需求详情结构 | 所有PRD需求输出 | 不负责具体业务分析 | 无 | 具体业务规则、项目方案 |
| Feature Requirement | Capability | Stable | 只能分析单个功能新增、优化、调整需求，覆盖功能目标、使用场景、页面、流程、数据、状态等需求维度 | 功能新增、页面优化、交互调整、字段新增、流程优化 | 完整活动项目、复杂运营玩法、独立业务系统设计 | PRD Base | 通用PRD规范、具体业务规则、项目参数 |
| Activity Requirement | Capability | Stable | 分析完整活动类需求，覆盖活动目标、参与流程、页面结构、展示规则和常见活动元素 | 排行榜活动、福利活动、运营活动、节日活动 | 单功能迭代、通用业务系统设计 | PRD Base | 具体活动规则、活动参数、奖励配置、计算公式、项目页面范围 |
| Activity Rule Extraction | Support Capability | Stable | 从活动页面需求中抽离重复业务规则，建立唯一活动规则来源 | 已有活动PRD整理、活动规则去重 | 首次生成普通功能需求、非活动需求 | PRD Base、Activity Requirement | 新活动规则、活动参数、页面视觉设计 |
| Live Requirement | Capability | Stable | 分析直播业务需求，包括直播对象、角色关系、直播生命周期、互动能力、直播模式、权限和状态模型 | LIVE、多人直播、连麦、PK、直播互动能力 | 纯语音房、普通社交聊天、非直播业务系统 | PRD Base | 具体项目规则、版本参数、玩法配置、RTC实现、商业化规则 |
| Room Requirement | Capability | Stable | 分析房间型产品需求，包括Room结构、成员关系、资源位置、加入退出流程、房间状态、权限模型和成员管理机制 | Party、语音房、多人房、聊天室、多人互动空间 | 单纯直播内容玩法、商业化系统、活动玩法、推荐系统 | PRD Base | 具体项目规则、版本参数、活动机制、礼物经济、直播玩法 |
| Prototype To Requirement | Support Capability | Stable | 将已有原型转换为研发可执行需求，同时保留既有页面结构、交互逻辑和信息层级 | Figma、Axure、页面截图或已有原型作为输入 | 无原型输入、需要重新设计产品方案 | PRD Base | 新业务规则、视觉设计、原型中不存在的功能 |
| Social Requirement | Capability | Draft | 处理用户关系和互动需求，包括关注、好友、聊天、匹配、互动行为、关系链变化 | Follow、Message、Match、社交互动 | 不负责内容推荐、直播系统 | PRD Base | 推荐算法、直播规则 |
| Monetization Requirement | Capability | Draft | 处理商业化需求，包括礼物、充值、消费、会员、付费权益、收益相关流程 | 礼物系统、充值、VIP、付费功能 | 不负责支付底层接口开发 | PRD Base | 财务系统、第三方支付实现 |
| User System Requirement | Capability | Draft | 处理用户成长体系，包括等级、经验、身份、勋章、权益、成长任务 | 等级体系、用户身份、成长体系 | 不负责活动奖励体系 | PRD Base | 具体运营活动方案 |
| Backend Requirement | Capability | Stable | 处理后台系统需求，包括配置页面、运营工具、审核流程、数据展示、管理权限 | 运营后台、管理后台、配置后台 | 不负责C端业务方案 | PRD Base | 数据库设计、接口设计 |
| Meeso Multi-Guest LIVE V1 | Project | Stable | 提供Meeso Multi-Guest LIVE V1的项目背景、范围、流程、规则和待确认项 | 明确关联到该项目版本的PRD生成 | 其他项目或更新版本 | Live Requirement、Room Requirement | 通用PRD规范、通用领域分析方法 |
