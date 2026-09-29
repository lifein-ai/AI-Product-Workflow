分类	可复用资产	变体 / 可配置项	适合复用	边界与注意事项
Basic	Button · 85×48	Primary / Secondary / Disabled；Label	CTA、确认、领取、表单操作	通用业务按钮，不包含具体流程
Basic	Tab · 65×48	Selected / Unselected；Label	内容切换、模式选择	仅提供两种选择状态
Basic	Card · 327×128	Title、Value、Supporting text	活动信息、指标概览	结构通用，不包含业务规则
Basic	Dialog Shell · 327×292	Title；Content / Actions Slot	确认、奖励、结果弹窗	只复用外壳，内容与操作需通过 Slot 注入
Basic	Bottom Sheet · 390×324	Title、Content / Actions Slot、Show Handle、Show Close	移动端设置、管理、短流程	不包含具体业务规则
Activity	Header · 375×56	Title、Action label、Show action	活动页顶部	面向 Activity 页面，不是全局 Navigation
Activity	Status · 327×84	Upcoming / Active / Finished；状态文案与时间	活动生命周期、倒计时	时间逻辑由具体活动提供
Activity	Prize Pool Card · 327×128	Label、Status、Amount、Description	奖池或总奖励概览	不绑定币种、礼物或计分方式
Activity	Ranking Item · 327×72	Default / Current User / Top3；排名、用户、数值	排行榜行	榜单规则和指标由业务配置
Activity	Ranking Container · 375×316	Title、Period	完整排行榜模块	内含 Top3、Default、Current User 三类 Ranking Item 实例
Activity	User Activity Card · 327×206	排名、指标、差距、历史入口；Show history	“我的活动数据”模块	字段可换，不限定积分模型
Activity	Reward Card · 327×126	Unclaimed / Claimed / Expired；奖励与操作文案	奖励列表、领取状态	不绑定奖励品类
Activity	Reward Content · 279×102	Awarded / Claim Success / Confirmation；Title、Message	奖励弹窗内容区	应放入 Dialog Shell，不建议单独作为完整弹窗
Activity	Reward Dialog · 327×292	Awarded / Claim Success / Confirmation	可直接复用的奖励弹窗	由 Dialog Shell、Reward Content、Button 组合
Activity	Record Item · 327×56	Time、Type、Value、Status	积分、消费、奖励记录行	数据格式由具体活动决定
Activity	Activity Record List · 375×256	Title	活动记录列表模块	内含 3 个 Record Item 实例，可继续扩展
LIVE	Room Header · 390×76	Host Name、Host ID、Viewer Count、Show Manage、Show Close	Normal LIVE、Connection、PK、Multi-Guest 顶部	不承载 Capacity、Layout、Seat；Normal LIVE 使用时需确认是否隐藏 Manage
LIVE	Room Bottom Bar · 390×72	Connection=Join / Guest Control；Type Placeholder	Audience 加入入口、Guest 控制态	Gift、Game、Message、More 固定；Guest Control 仅用于成功连麦后
LIVE	Guest Seat	Large 252×220 / Compact 120×120；Occupied / Empty / Locked / Disconnected	Multi-Guest 座位和布局	Host 不属于 Guest Seat；Capacity、布局和座位分配规则仍由项目管理
LIVE	Join Request Item · 342×108	Pending / Accepted / Rejected / Invalid × Video / Audio；User Name	Host 侧连麦申请列表	V1 不支持指定座位申请；Pending 不占用 Seat
页面模板	LIVE Base / Host · 390×844	Header、Badges、主视频、Chat、底栏	Connection / PK / Multi-Guest 的 Host 起点	标注为 Normal LIVE baseline；当前底栏仍含 Hotspot/Join，复用前建议确认
页面模板	LIVE Base / Audience · 390×844	Header、Badges、主视频、空 Chat、底栏	Connection / PK / Multi-Guest 的 Audience 起点	标注为 Normal LIVE baseline；当前底栏仍含 Hotspot/Join
Foundation	Variables	Primitives 13、Dimensions 13、Semantic 15	颜色、间距、圆角、触控尺寸	共 41 个变量；单 Default Mode
Foundation	Styles	7 个 Activity 文字样式；Card / Dialog 两个阴影样式	页面标题、模块标题、正文、标签、数字和浮层	当前没有 Paint Style 或 Grid Style