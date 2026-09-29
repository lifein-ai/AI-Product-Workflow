# Multi\-Guest Live Capability

## Capability定位

定义多人直播产品的通用对象模型、页面结构、状态模型和交互模式。

解决：“多人直播产品通常如何设计。”

## 核心能力

- 角色模型：定义 Host、Audience、Guest 三类核心角色及其基础关系。

- Seat模型：定义多人直播中的固定参与位置、位置状态和身份关系。

- Join模型：定义观众进入多人直播的通用加入流程。

- Capacity模型：定义直播容量变化涉及的参与者、位置和布局关系。

- Layout模型：定义多人直播视觉排布与参与者身份之间的关系。

- 管理模型：定义Host对房间、Seat和Guest的管理能力。

- 状态模型：定义多人直播中的核心状态变化。

## 通用设计模型

## 1\.角色模型

多人直播通常包含：

- Host：直播创建者，负责房间管理；

- Audience：观看用户，可通过加入流程成为Guest；

- Guest：参与连麦的用户。

不同角色具有不同操作权限。

## 2\.Seat模型

Seat表示多人直播中的参与位置。

需要区分：

- Seat Identity：位置身份；

- Seat State：位置状态；

- Visual Position：视觉展示位置。

常见Seat状态：

- Empty；

- Locked；

- Occupied；

- Audio Guest；

- Video Guest。

Seat身份与视觉布局可以解耦。

## 3\.Join模型

多人加入流程通常包含：

Audience → Join → Request / Direct Join → Seat Allocation → Guest

支持常见加入方式：

- Unified Join；

- Specific Seat Join；

- Apply Join；

- Free Join；

- Host Invite。

## 4\.Request模型

存在审批流程时，需要表达请求生命周期：

- Pending；

- Accepted；

- Rejected；

- Invalid / Expired。

## 5\.Capacity与Layout模型

Capacity表示房间可容纳参与者数量。

Layout表示参与者视觉排列方式。

设计时区分：

Capacity变化影响参与位置；

Layout变化影响视觉展示。

Layout不默认改变Seat身份。

支持根据项目需求扩展：

- Equal Layout；

- Main Layout；

- Main Participant。

## 6\.Host管理模型

Host通常管理：

Room Level：

- Capacity；

- Layout；

- Join Policy；

- Join Request。

Seat / Guest Level：

- Invite；

- Lock / Unlock；

- Mute；

- Camera Control；

- Remove；

- Set as Main。

具体操作根据项目需求定义。

## 7\.状态模型

多人直播需要关注：

- Seat State；

- Guest State；

- Join Request；

- Capacity；

- Layout；

- Main Participant；

- Permission；

- Connection State。

## 页面与交互模型

根据项目需求组合：

- 主直播页面；

- Seat区域；

- Join入口；

- Request管理；

- Host管理面板；

- Dialog；

- Bottom Sheet；

- State Variant。

核心流程：

Audience：

Join → Request / Direct Join → Seat → Guest → Leave

Host：

Invite / Approve → Guest加入 → Seat / Guest管理

