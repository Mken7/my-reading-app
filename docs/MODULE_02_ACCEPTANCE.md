# 一级模块 02 · 登录、邮箱确认、密码恢复与身份隔离

**交付口径：V2 独立预览的代码与自动化验收。没有正式 Supabase 身份服务或真实邮件交付 E2E，不能视为已经对外开放。**

## 本模块包含的功能

1. **邮箱密码注册与登录**：注册最低 12 字符、最多 128 字符；登录沿用服务端密码规则。密码使用受控表单，提交后清空，不写入本地草稿或 URL。Supabase Auth 是唯一认证提供方，前端不自行生成密码哈希、身份令牌或管理员权限。
2. **邮箱确认状态**：支持请求重发验证邮件；尚无已确认邮箱状态的会话只展示验证引导，不能通过页面操作查看书房或发起正文查询。确认后从 Supabase Auth 获取已验证身份，再刷新会话，避免只相信浏览器本地的标志。邮件是否送达以及真实邮箱确认策略取决于独立 staging Supabase Auth 配置。
3. **忘记密码**：通过 Supabase Auth 请求找回邮件，不暴露该邮箱是否注册；找回回调只允许指向当前应用 /v2 路径，支持本地 localhost 和 GitHub Pages 的单一仓库前缀。禁止第三方域名回跳、非本地明文 HTTP、不安全路径及保留密码/令牌查询参数。
4. **重置口令的专属保护界面**：必须由 Supabase Auth 的 PASSWORD_RECOVERY 事件授权，普通登录与 token 刷新不能自行开启重置表单。恢复期间不展示书房和成员、正文请求暂停。更新密码后请求全局退出其他会话；如果退出失败，保持恢复专属界面，可重新尝试退出，不能把失败冒充安全成功。
5. **失效令牌现实限制**：服务端全局退出撤销刷新会话，但已经签发的访问 JWT 可能一直有效至到期。本模块不会宣称立即注销所有已签发的 JWT。密码强度、泄露密码检测、邮件速率、会话最大存活时间还须在独立 Supabase 后台和可信服务层配置。
6. **会话隔离**：退出、跨账号登录或恢复会话切换时清理当前页面的房间、邀请明文、申请列表与阅读器；用身份世代和请求版本来忽略旧用户迟到的网络响应。来自 V2 的访问不会静默连接旧版项目和旧 localStorage 身份。
7. **强制 V2 环境隔离**：独立的 V2 项目必须配置显式预览开关、非正式项目的 HTTPS Supabase .supabase.co 根地址和 publishable key；拒绝正式项目地址、含凭据的 URL、任意域名、非 TLS 及 URL 中的搜索参数。SDK 按隔离 storageKey 保存测试会话，绝不提交 service_role 或其他管理员私钥。
8. **身份与数据库授权分离**：邮箱确认引导是 UI 保护，不替代数据库 RLS 或独立 Auth 服务配置；私人与共享书房资源最终仍必须经过 auth.uid()、活动成员及 V2 RLS/RPC 验证。不能只凭邮箱字符串或前端验证标志获取访问权限。

## 自动化验收依据

- 实现代码：lib/v2/authSafety.ts、lib/v2/staging.ts、app/v2/V2Preview.tsx。
- Node 单元测试：tests/unit/authSafety.test.mjs，核对正式环境主机阻断、重置链接 origin/路径校验与去除查询/片段、口令长度、SIGNED_IN/PASSWORD_RECOVERY/TOKEN_REFRESHED/USER_UPDATED/SIGNED_OUT 状态映射。
- Chromium：tests/browser/queue.html 编译并执行真实的 authSafety.ts；验证浏览器 location.origin 的密码恢复 URL 没有带入 token、正式 Supabase 地址不会被视为 staging、普通登录不解锁修改密码以及 USER_UPDATED 不重置恢复过程。
- GitHub Actions：verify 执行 Node 测试、strict ESLint、Next.js TypeScript/static build；browser-queue 运行真实 Chromium；database-security 对原有房间/笔记访问继续执行隔离 PostgreSQL 16 的 RLS 回归。必须最后同一 commit 三项都通过才能称为代码验收。

## 明确没有冒充完成的事情

- **独立真实 staging Supabase 尚未配置。** CI 不会真实注册测试邮箱、投递确认邮件、点击真实密码找回链接或检查真实 Auth 提供方的会话传播。因此真正的邮箱投递/三账号 Auth + API RLS 联调与 iOS/Android 真机 E2E 属于第 14 大模块。
- 本模块没有开发可信的 IP/设备注册风控、泄露密码库检查或滥用申诉网关；需要第 13 模块及独立 Supabase Auth 后台策略支持。客户端禁用按钮并非真正的服务端限流。
- 未登录者不应获得 JWT；已获登录会话的邮箱确认状态仍应由独立 Supabase Auth 的“确认邮箱”配置管理。前端确认邮箱门禁不构成独立后端身份认证规则。
- 没有删除账号、请求个人信息完整导出、保留期策略或逐项抹除旧数据；相关能力归第 12/13 模块。
- 所有提交仅在 feat/phase0-foundation-2026-10-18 开发分支，PR #1 保持草稿。不改 main、备份分支、生产 Supabase，也没有部署或增加付费项目。

**“100%”只对应本模块明确的应用代码与自动化测试范围，不代表真实在线身份服务已经经过安全/用户验收。**
