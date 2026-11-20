# 参与贡献

zxb bot 是个人本地网关和它的前台。它不是官方 Grok Bot。

## 开始

使用 Node.js 22.18 或更新版本，以及 pnpm 11.19。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:mobile
pnpm lint
pnpm test
pnpm --filter @pa/desktop build
```

`pnpm test` 不调用实况模型。不要把真实供应商密钥放进测试或提交。

## 不要提交

- `.env`、真实 `OPENAI_API_KEY`、设备令牌、配对码
- `data/`、SQLite、LangGraph checkpoint、`credentials.bin`
- `node_modules/`、构建目录、本地证据和截图
- 别人的商标、参考截图或未确认许可的代码

可以保留 `fixtures/` 里的原创演示文本。测试依赖其中的哨兵字符串。

新增或升级依赖时，在 `THIRD_PARTY_NOTICES.md` 写明包名、版本和许可证。双许可要写明本仓库选择哪一支。不要把第三方代码的许可证改成仓库根上的 MIT。

## 包名

npm 包名仍是 `personal-agent` 和 `@pa/*`，并且标了 `private`。界面和文档里的产品名是 `zxb bot`。不要把界面对外名称改成 Grok Bot 或其他产品名。
