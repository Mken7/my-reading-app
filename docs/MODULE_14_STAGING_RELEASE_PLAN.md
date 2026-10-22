# 第 14 一级模块｜真实环境、设备与上线门禁（未验收）

> **状态：进行中，不得标记完成。** 本文是验收执行手册，不是模块验收报告或上线许可。
> 所有步骤限定于独立 Supabase 测试项目、模拟账号和合法测试文字。不得触碰原版生产 Supabase / 正式阅读用户。

## 已有自动化证据

- `validate-pr.yml` 在 PR 上自动运行 Node 单元测试、严格 ESLint、Next.js 静态构建、独立 PostgreSQL 16 的完整 RLS/SQL 回归、Chrome IndexedDB/EPUB/PDF/响应式阅读器测试。
- `tests/browser/run-v2-static.cjs` 实际打开 Next.js 静态导出的 `/my-reading-app/v2/`，检查默认关闭、不显示登录表单、不向 Supabase 发送请求及无横向溢出；判定改为读取**已执行的浏览器 DOM 结果节点**，不能再以源代码里出现 PASS 字样误报。普通 Chromium `--window-size=390` 有最小约 500px 的限制，输出需以**实际 `innerWidth`** 为准。
- `tests/browser/run-v2-auth-cdp.mjs` 则用无真实密钥的虚构 staging 配置，创建**不发布的**第二套静态构建，通过 Chromium DevTools Protocol（CDP）精确设置 390/430px 触控视口和 768/1280px 桌面视口，实际等待 React hydration 的邮箱与密码登录表单，并检查标签、横向溢出和触控模拟。**这是真实 Chromium 渲染，但不是 Safari/Android 真机，也没有实际登录数据库。**
- `tests/staging/run-supabase-e2e.mjs`：**只交付脚本，未有通过的真实环境证据**。该脚本在手动提供的独立测试库、三组已验证邮箱账号上执行：Auth 登录、匿名/非成员读权、六位邀请码及房主审批、版权声明、受保护段落上传、原文和未来共享笔记隔离、实际 Realtime 事件、成员退出撤权、双方同意后销毁新建的临时书房。
- 隔离 staging 脚本**不会在常规 PR CI 中运行**；未来 `staging-three-accounts` GitHub 手动 job 还需要在默认分支建立工作流后才能实际触发。缺少测试项目标识、账户或明确测试环境确认时测试脚本失败关闭。脚本会创建并删除一次性测试书房，可能消耗限额；失败时仅输出临时房间 ID 和检查阶段，不打印密钥。

## 真实独立 Supabase 准备（阻断项）

1. **先创建单独的 Supabase 测试项目**，确定它不等于原版已使用的生产项目。不要共享生产账号、用户表数据或 service_role/管理员密钥。提前检查免费额度、账单与网络政策，避免未经同意产生费用。
2. 使用测试项目数据库依**文件名顺序**运行 `supabase/migrations/` 的所有 20261018*/20261019* V2 SQL 文件，含最新 `20261019190000_v2_security_copyright_audit.sql`。留存迁移检查记录、Supabase Realtime `supabase_realtime` publication 的目标表和 Postgres RLS 配置证据。不要对老数据库迁移。
3. 在 Auth 开启 Confirm Email 和正确的测试邮箱/密码登录配置。提前创建和完成邮箱确认的 **三组独立测试用户**（房主、伙伴、无关第三人），不要使用个人常用密码。
4. 在本机安全环境变量（**不要提交到代码仓库**）中配置 `V2_STAGING_URL`、`V2_STAGING_PROJECT_REF`、`V2_STAGING_PUBLISHABLE_KEY`、`V2_STAGING_OWNER_EMAIL`、`V2_STAGING_OWNER_PASSWORD`、`V2_STAGING_PARTNER_EMAIL`、`V2_STAGING_PARTNER_PASSWORD`、`V2_STAGING_OUTSIDER_EMAIL`、`V2_STAGING_OUTSIDER_PASSWORD`，并明确设置 `V2_ALLOW_MUTATING_STAGING_TEST=I_CONFIRM_ISOLATED_STAGING_ONLY`。执行 `node tests/staging/run-supabase-e2e.mjs`。**不要把凭据粘贴到 GitHub issue、README、PR 或公开聊天。** 目前 `validate-pr.yml` 仅在功能分支，GitHub 的 `workflow_dispatch` 通常要求工作流先存在于默认分支，故**不可声称当前就能从 Actions 页面手动运行 staging job**；该 job 是未来经过独立审查后合并工作流才可能启用的途径。目前必须从安全本地测试机运行。
5. `staging-three-accounts` 必须绿色，且由实际操作人员复核测试库：真实确认/恢复密码邮件、Realtime 断线重连、伙伴取消权限后订阅停止、请求配额重试、移动端表单状态、书房历史/注销/报告审核、超长书籍实际导入、储存空间和跨账号缓存清除。纯 HTTP RPC 实际联调**不能代替网页点击端到端流程**。
6. 测试完成或中断时核对临时书房与临时内容是否被删除（脚本异常会输出房间 ID 供操作者使用受控数据库清理）。不可为了清理失败而删除测试环境里的其他人的资料。

## 真机兼容性矩阵（尚未执行）

| 平台与设备 | 必须使用真实系统浏览器完成的动作 | 结果 |
|---|---|---|
| iPhone Safari（最新受支持 iOS） | 邮箱回跳、中文输入法、导入文件、长段落、字号、玻璃浮球、离线再开、书签与恢复 | ☐ 尚未验证 |
| Android Chrome | 注册/登录、加入/审批、EPUB/PDF/TXT 导入、文字长按划线、批注、断线重连及退出 | ☐ 尚未验证 |
| Windows Chrome/Edge | 双页/单页断点、键盘焦点、右页批注独立、两账号同时编辑、刷新恢复、导出/归档 | ☐ 尚未验证 |
| macOS Safari（如目标发布范围含 macOS） | Safari WebKit 字体、焦点、IndexedDB、离线恢复、上方/底部安全区 | ☐ 尚未验证 |
| 可访问性 | 键盘独立操作、标签/状态朗读、对比度、减少动画、200% 放大、触控按钮大小、错误说明 | ☐ 尚未验证 |

测试报告至少保存测试人员、日期、设备型号/OS/浏览器版本、匿名化截图、预期/实际及缺陷复测结果。**Chromium 模拟视口不是 iOS Safari 证据。**

## 发布前硬性检查

- [ ] 对 `npm ci` 的安全告警逐项复核，运行 `npm audit --omit=dev` 与开发依赖完整审计；修复或记录已知漏洞的适用性、版本及临时缓解措施。日志曾显示 14 项依赖告警（含高危和严重级），**不能仅凭静态构建或绿色 lint 宣称依赖安全**。
- [ ] 独立测试 Supabase 全迁移通过；三组真实账号、Auth 邮件、浏览器双人 E2E 通过；权限撤销与 Realtime 订阅失效实测
- [ ] iPhone Safari、Android Chrome 与至少一种桌面浏览器真实测试通过，关键无障碍路径通过
- [ ] 在独立测试项目完成重复迁移、备份与恢复、回滚演练；上线迁移程序经过人工审查，**不允许先修改生产数据库试错**
- [ ] 已确定本人数据导出、账号注销、存储副本销毁、保留期限与真实用户投诉/申诉处理的可操作制度
- [ ] 版权投诉机制、管理员最小权限、IP/跨账号风控、独立第三方安全审核、审计外部锚点均已实际部署并留下可核验记录
- [ ] 正式部署域名、HTTPS、限额费用风险、事故响应、停机/回滚、访问审计、备份恢复和合法测试读物确认
- [ ] 上线审批由实际所有者明确完成，才可将开发 PR 合并至正式分支。ChatGPT 不得代替所有者发布，也不得用 CI “绿色”替代外部门禁

## 不应采用的捷径

不要复用旧 Supabase 凭据，不要在 `NEXT_PUBLIC_*` 存私钥或 service_role，不要将孤立的 PostgreSQL 假身份视为真实 Supabase RLS，不要把 Netlify 预览可加载视为完成真实双人验收。**本项目尚不满足上线门禁，因此第 14 模块不能标记为 100%。**
