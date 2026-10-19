# 第 10 模块 / 第 1 阶段：同伴在线状态（开发分支，尚未验收）

**状态：提交了 staging-only 代码和权限测试，不等于第 10 一级模块验收或发布。**

## 变更

- 数据表 `reading_presence_v2(room_id,user_id,last_seen)` 仅保存每位房间成员的心跳时间；不保存、传送或广播书籍正文、章节、选中句子、批注、阅读进度或设备信息。
- `v2_heartbeat_reading(target_room)` 基于 `auth.uid()` 验证当前有效成员，20 秒内最多一次写入，不接受客户端传来的目标用户、位置信息或时间戳。
- `v2_read_companion_presence(target_room)` 在数据库内计算是否有另一个成员和该成员最近 90 秒内是否活跃；对非成员/关闭书房返回空结果，**不返回任何用户 ID 或时间戳**。
- PostgreSQL SELECT RLS 仅允许活动房间成员读取活动成员的心跳，匿名、跨房间、已离开的成员以及关闭书房均拒绝。
- PostgreSQL Changes（非 Broadcast）的 `reading_presence_v2` 事件只提醒页面重新读取上述权威 RPC。任何未知、乱序、失效或失败的快照都显示“无法确认”，不能导致页面跳转。
- 30 秒可见页面心跳、60 秒后备同步；页面后台不继续发送活动心跳。登出/切换书房时 React Effect 取消订阅、定时器和请求结果。
- 双人共读面板显示“最近 90 秒是否活跃”，不是对方精确定位，也不是实时同步两人的页码。支持关闭 Realtime 时由后备同步刷新。

## 权限与可靠性边界

1. **仅限独立 staging Supabase**，按既有 V2 迁移顺序最后执行 `supabase/migrations/20261019150000_v2_companion_presence.sql`。不要在旧版正式数据库运行。
2. Realtime 必须启用并包含 `reading_presence_v2` 的 `supabase_realtime` publication。迁移在 Supabase publication 存在时加入该表；CI 的隔离 PostgreSQL 没有此 publication，因此**只验证 SQL/RLS，不验证线上 WebSocket 交付**。
3. Realtime 事件没有书籍和阅读位置，数据库 RPC 决定真实访问权。离房/关房在服务端立即拒绝读写；客户端直到下次校验前可能保留最后一次文本状态显示，因此**不能把此状态当作身份安全凭据**。
4. 活跃状态为 90 秒滑动窗口，不是可靠的“已读回执”，关闭页面、断网、设备休眠、刷新以及浏览器后台节流均会影响活跃提示。
5. 反剧透目前通过**不共享阅读位置**来确保这个在线功能不会剧透；全 App 的注释推送、共享消息提前预览、未来章节标题等仍须实现服务端防剧透策略，不能用本模块的在线信号替代。
6. 测试覆盖 `tests/unit/companionPresence.test.mjs` 和 `tests/sql/reading_presence_v2_smoke.sql`；数据库测试包括双成员、非成员、撤销成员、关闭书房及匿名角色。仍待真正 staging Auth/Realtime 双账号和 iOS/Android 端到端验收。

## 下一步

- 完成受控的章节、引用和共享批注“主动查看”解锁与服务端防剧透规则。
- 真实 staging 环境跑多账户异步重连、乱序通知、撤销权限和移动设备断网恢复。
- 审查权限与性能之后才更新 `docs/MODULE_PROGRESS.md`，创建 `MODULE_10_ACCEPTANCE.md`；当前一级模块仍按**未完成**处理。
