# Figma Prompt Registry（Figma Prompt能力索引库）

|Prompt名称|层级|状态|核心职责|适用场景|不适用场景|依赖Prompt|不包含内容|
|---|---|---|---|---|---|---|---|
|Figma Base|Base|Stable|定义所有 Figma 原型制作基础规范，包括文件结构、Frame规范、页面命名、Auto Layout、Prototype、原型原则、安全修改规则、Component Usage|所有 Figma 原型项目|不负责具体产品类型设计、不负责业务流程设计、不负责组件资产治理|无|页面业务逻辑、活动玩法、后台结构、专项设计能力、公共组件治理|
|Backend Capability|Capability|Stable|定义后台系统设计能力，包括后台页面结构、数据展示、配置流程、表格管理、筛选查询、状态表达、权限操作等通用设计规则|运营后台、管理后台、数据后台、配置系统|不包含具体业务规则、行业玩法、项目数据逻辑、具体后台需求|Figma Base|活动规则、业务数据、具体后台模块名称、项目配置逻辑|
|Activity Design Capability|Capability|Stable|定义运营活动类页面结构、信息组织、参与流程和状态模型|活动页、任务活动、排行榜活动、奖励领取活动|非活动类产品页面、品牌营销页、复杂业务系统|Figma Base|不包含具体活动规则、奖励配置、业务参数、单项目玩法|
|Multi\-Guest Live Capability|Capability|Stable|定义多人直播的角色、Seat、Join、Layout、状态和管理模型|多人直播、视频连麦、多嘉宾互动场景|单人直播、非实时互动产品|Figma Base|不包含具体人数、Seat配置、业务规则、加入策略、项目流程|
|Component Reuse Capability|Support Capability|Draft|定义原型制作阶段的已有组件发现、复用和安全替代流程；其主要规则已并入Figma Base V2|需要专项组件复用检查的原型任务|组件库治理、Design System建设|Figma Base|页面结构设计、业务流程设计、公共组件治理|
|Component Library Governance Capability|Maintenance|Stable|原型完成后进行组件盘点、规范、复用判断和资产沉淀|独立组件治理任务|业务原型制作阶段|无|业务页面制作、产品逻辑和单项目玩法|


