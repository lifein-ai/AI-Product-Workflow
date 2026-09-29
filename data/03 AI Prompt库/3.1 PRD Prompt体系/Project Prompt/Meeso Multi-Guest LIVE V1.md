# Meeso Multi\-Guest LIVE V1

项目背景：

Meeso LIVE 当前支持单 Guest 连线能力，Party 已具备固定 Seat、Apply Mic、Invite、Lock Seat、Video Seat 等多人房基础能力。本期计划在 LIVE 中新增独立 Multi\-Guest LIVE 模式，将多人互动能力从 Party 扩展至 LIVE 场景。

产品定位：

- Party：偏多人语音社交；

- LIVE：偏视频直播、Multi\-Guest、PK 等视频互动场景。

本项目目标是建立 LIVE 多人视频直播基础能力，为后续 PK、Team PK 等玩法提供基础架构。



产品目标：

- 支持主播创建多人视频直播房间；

- 支持 Host、Guest、Seat、Capacity、Layout 等多人直播核心模型；

- 支持观众加入、申请、邀请和主播管理 Guest；

- 建立可扩展的 Multi\-Guest LIVE 基础能力。

    

用户范围：

- Host：创建并管理 Multi\-Guest LIVE 的主播；

- Audience：观看直播并申请/加入 Guest Seat 的观众；

- Guest：加入直播并参与互动的用户。

    

# Business Scope

业务范围：

- Multi\-Guest LIVE 开播模式；

- Host \+ Guest Seat 固定座位模型；

- 4/6 人 Capacity 管理；

- Equal/Main Layout 管理；

- Audience Join 流程；

- Guest Seat 管理；

- Host Guest 管理。

    

核心流程：

1. Host 创建 LIVE；

2. Host 选择 Normal LIVE 或 Multi\-Guest LIVE；

3. Host 配置 Capacity（4/6）和 Layout（Equal/Main）；

4. 开启 Multi\-Guest LIVE；

5. Audience 通过统一 Join 或指定 Seat 加入；

6. 根据 Join Policy 进入申请流程或直接进入 Seat；

7. Host 管理 Guest、Seat 和 Layout；

8. Guest 参与直播或主动退出。

    

# Requirement Details

页面范围：

- LIVE 开播配置页；

- Multi\-Guest LIVE 房间页面；

- Multi\-Guest 管理入口；

- Join Request 列表；

- Seat 操作面板；

- Guest 状态展示。

    

功能说明：

|功能模块|说明|
|---|---|
|Multi\-Guest 模式|LIVE 新增独立多人直播模式，与 Normal LIVE 区分|
|Capacity|支持4人、6人模式切换|
|Layout|支持 Equal Layout、Main Layout|
|Seat|固定 Seat 模型，Seat ID 与展示位置分离|
|Join|支持统一 Join 和指定 Seat Join|
|Join Policy|支持 Apply Join、Free Join|
|Seat 管理|支持 Invite、Lock、Unlock、Set as Main、Remove 等操作|
|Guest 管理|支持静音、关闭摄像头、退出等操作|



业务规则：

- Multi\-Guest LIVE 模式：

    - Normal LIVE 与 Multi\-Guest LIVE 单场直播内不可切换。

    - Host 独立于 Guest Seat。

    - Empty Seat 持续展示。

    - Audio / Video Guest 均占用完整 Seat。

        

- Capacity：

    - 支持4人模式：1 Host \+ 3 Guest。

    - 支持6人模式：1 Host \+ 5 Guest。

    - 4→6：新增空 Seat，保留已有 Guest。

    - 6→4：仅当 Guest 数量 ≤3 时允许。

    - 缩容不会自动移除 Guest。

        

- Layout：

    - 支持 Equal 和 Main。

    - Main Layout 默认 Host 为 Main。

    - Host 可 Set Guest as Main。

    - Set as Main 不改变 Seat ID。

    - Main Guest 离开或被移除后恢复 Host 为 Main。

    - Capacity 切换保持当前 Layout 类型。

        

- Join：

    - Audience 支持统一 Join 和指定 Seat Join。

    - Locked Seat 不允许 Audience 自主加入。

    - Apply Join 需要 Host 审批。

    - Free Join 无需审批。

        

- Seat：

    - Empty Seat 支持 Invite、Lock/Unlock。

    - Occupied Seat 支持 Set as Main、Mute、Turn Off Camera、Remove。

    - Audio Guest 不展示 Camera 操作。

        

- Guest：

    - 上麦前选择 Audio / Video。

    - 上麦后支持 Camera 开关、Mute、Leave Seat。

    - Guest 不允许修改 Capacity、Layout、Seat 权限。

        

数据要求：

- 当前未定义具体数据指标。

- 【待确认】是否需要统计：

    - Multi\-Guest 开播次数；

    - Guest 加入次数；

    - Join 转化率；

    - Seat 使用率；

    - Live互动指标。

        

状态规则：

|对象|状态|
|---|---|
|Join Request|Pending / Accepted / Rejected / Invalid / Expired|
|Seat|Empty / Occupied / Locked|
|Guest|Joined / Left|
|Layout|Equal / Main|
|Capacity|4 / 6|



# Scope Control

本期范围：

- Multi\-Guest LIVE 模式；

- 4/6 人固定 Seat；

- Equal/Main Layout；

- Host Guest 管理；

- Join Request；

- Apply Join / Free Join；

- Seat Invite、Lock、Remove 等基础管理能力。

    

非本期范围：

- 9人及以上纯视频模式；

- Seat Move；

- Seat Swap；

- Seat 拖拽换位；

- 自定义 Seat 数；

- 自定义 Layout 编辑器；

- Normal LIVE 与 Multi\-Guest LIVE 中途切换；

- PK；

- Team PK；

- Battle；

- 复杂 Audience 推荐 Invite。

    

待确认事项：

- Party Seat、Apply、Invite、Lock 能力复用范围；

- RTC 是否支持4/6路视频同时在线；

- 低端机和弱网性能；

- Audio/Video 动态切换能力；

- Host 强制关闭 Guest Camera 能力；

- Seat ID 与 Display Position 解耦实现；

- Capacity 动态切换实现方案；

- Join Request 与 Seat 占用并发处理；

- Guest 断线重连后的 Seat 保留规则。

