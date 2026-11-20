# 安全说明

本仓库还没有指定安全联系邮箱或漏洞披露流程。这里不提供一个临时地址。公开到某个 Git 托管之前，不要把漏洞报告发到仓库作者字段里的自动化地址。

## 使用边界

- 网关默认只听回环地址。把 `PA_HOST` 改成非回环地址时，还必须显式设置 `PA_ALLOW_UNSAFE_LAN=1`，而且这条链路没有 TLS。
- 设备令牌和配对码只应存在于网关签发之后的本机内存、Electron 已有的安全存储或手机的 Expo SecureStore。不要写进 URL、日志、HTML 属性或浏览器 `localStorage` / `sessionStorage`。
- 演示模式不读取 `OPENAI_API_KEY`，也不会在缺少密钥时改走实况模型。
- `PA_TEST_HOOKS` 在生产必须保持关闭。
- 写入路径限制和账本去重不是操作系统沙箱，也不是对任意外部系统的恰好一次保证。

## 本次扫描说了什么

扫描对象是准备开源时的已跟踪文件，以及 `git log -p` 里对密钥样式、邮件地址、飞书、Miaoma 和本机绝对路径的文本检索。范围包括当前树中的源码、文档、夹具、锁文件和脚本。

这次检索看到的是：

- 测试里的合成哨兵 `sk-test-LEAK-PROBE-9f3a`，用来断言它不会进入日志或数据库。它不是可用的供应商密钥。
- 提交作者是 `Cursor Agent <cursoragent@cursor.com>` 和 `Cursor <noreply@cursor.com>`。没有个人邮箱。
- 旧提交里的脚本默认路径含 `/opt/cursor/artifacts`。当前树已改成仓库内的 `artifacts/`。历史提交没有重写。

没有在已跟踪树里看到 `.env`、真实供应商密钥、设备令牌、配对码、飞书文档或口令、Miaoma 素材、证据包或本地数据库。`.gitignore` 排除了 `.env`、`data/`、SQLite、`node_modules/` 和 `artifacts/`。

这不是全盘取证。正则没有命中，不等于绝对没有敏感内容。扫描没有覆盖未安装的原生 SDK、编辑器本地历史、未跟踪文件，也没有人工阅读每一个传递依赖的源码。
