# zxb bot

单人使用的本地个人助理。界面上的产品名是小写 `zxb bot`。一台 Gateway 保存会话、运行、审批和工具账本；命令行、桌面和手机只是前台。演示模式是确定性脚本，会标明自己不是大模型，并且走同一套网关、持久化和人工审批代码。

## 仓库

指定的 GitHub 仓库是 <https://github.com/youngxiaobin/zxb-bot.git>。取得一份已同步的副本后：

```bash
git clone https://github.com/youngxiaobin/zxb-bot.git
cd zxb-bot
git pull
```

下面的安装和运行命令在仓库根目录执行。

## 环境

已在 Node.js 22.23.4 与 pnpm 11.19.0 上跑通。要求 Node.js >= 22.18。

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
```

复制环境变量示例。不要把真实密钥写进仓库、桌面渲染进程或手机包。

```bash
cp .env.example .env
```

## 启动

开三个终端：

```bash
pnpm dev:gateway
pnpm pairing-code
pnpm dev:desktop
```

Gateway 默认只听 `127.0.0.1:47471`。桌面预览是 `http://127.0.0.1:47331`。

1. 打开桌面预览，点左下角「我的」。
2. 展开「本机配对」，点「申请本机配对码」，再点「配对并连接」。新用户不需要自己从数据库里取出令牌。
3. 点侧栏「+」新建真实会话，在底部输入框发送委托。演示任务会读取 `fixtures/`，在写入 `sandbox/notes/<运行编号>.md` 前停下。
4. 时间线卡片里批准或拒绝。已结束的审批按钮会禁用。
5. 已经有设备令牌时，可以在「设备令牌」里保存并重新连接。网页预览只把令牌放在内存里，刷新后需要重新连接。更换 Gateway 会清掉原来的快照和游标。

另一个客户端可以批准或拒绝。

命令行：

```bash
pnpm dev:cli -- pair
pnpm dev:cli -- chat
pnpm dev:cli -- status
pnpm dev:cli -- approve <审批编号>
pnpm dev:cli -- reject <审批编号>
pnpm dev:cli -- cancel <运行编号>
```

手机需要手动填写网关地址。只有同时设置下面两项，网关才会听非回环地址，而且流量没有 TLS：

```bash
PA_HOST=0.0.0.0 PA_ALLOW_UNSAFE_LAN=1 pnpm dev:gateway
```

配对码仍然只能在网关所在电脑上用 `pnpm pairing-code` 签发。手机回到前台会补拉快照，没有后台推送。

```bash
pnpm --filter @pa/mobile start
```

## 检查

```bash
pnpm typecheck
pnpm typecheck:mobile
pnpm lint
pnpm test
pnpm --filter @pa/desktop build
```

`pnpm test` 不需要供应商密钥，也不会因为环境里存在密钥就调用实况模型。实况调用没有包含在默认测试里。

## 开源

仓库里 Xiaobin Zeng 有权开放的原创源码和文档使用 MIT 许可证，版权年份 2026。全文见 `LICENSE`。第三方依赖不因此变成 MIT，边界写在 `THIRD_PARTY_NOTICES.md`。参与方式见 `CONTRIBUTING.md`，安全边界见 `SECURITY.md`，以后的公开检查见 `docs/release-check.md`。

npm 包名 `personal-agent` 和 `@pa/*` 仍然是 `private`，避免被意外发布到 npm。产品名称是 `zxb bot`，它不是官方 Grok Bot。

演示模式是确定性脚本，读取 `fixtures/` 的原创示例，并在写入前等待批准。实况模式只有在网关进程持有 `OPENAI_API_KEY` 时才会使用兼容接口；缺少密钥时不会自动改回演示。网页前台不保存供应商密钥。

当前限制：工具不能执行任意命令；写入只有受审批的演示笔记；路径检查不是操作系统沙箱；没有 SSE。TypeScript Electron 主进程和 preload、Expo 真机或模拟器、实况模型调用都还没有作为已通过的验证。

## 原生构建还没验证

桌面主进程要求上下文隔离、关闭渲染进程 Node、沙箱和有限的预加载脚本。当前仓库可以构建网页渲染器。Electron Forge 的安装包 maker、签名和自动更新没有配置。本次没有把 TypeScript Electron 主进程或 preload 当作已执行的验证。

手机依赖 Expo SDK 52、Expo Router 和 SecureStore。构建开发客户端需要本机 Android SDK 或 Xcode。本次没有运行真机或模拟器。

## 限制

阅读 `docs/architecture.md`、`docs/decisions.md`、`docs/api.md`、`docs/schema.md` 和 `docs/backlog.md`。工具不能执行任意命令。写入只有一个需要审批的演示笔记。路径检查不是操作系统沙箱。演示账本会避免对同一次逻辑写入再执行，但这不是任意外部副作用的恰好一次保证。没有 SSE，实时通道只有 WebSocket。
