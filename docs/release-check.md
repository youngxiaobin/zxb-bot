# 发布检查

这份清单用于以后把 zxb bot 放到用户自己的 GitHub 仓库。本次只准备材料，不创建仓库，不推送，不部署。

## 公开前

- [ ] 用户给出目标仓库，并明确要求推送。
- [ ] `LICENSE` 仍是 MIT，版权行为 `Copyright (c) 2026 Xiaobin Zeng`。
- [ ] `THIRD_PARTY_NOTICES.md` 与锁文件一致；MPL、CC-BY、Electron 二进制和未写明 BSD 版本的条目没有被改成 MIT。
- [ ] `readline@1.3.0` 仍只有 “BSD” 而没有条款文件。公开安装图前确认是否接受这个传递依赖，或等待上游发布带 SPDX 标识的新版本。不要把 2015 年的 npm 包写成 2025 年仓库里的 Apache-2.0。
- [ ] 源码包不含 `.git`、`.env`、`node_modules/`、`data/`、SQLite、checkpoint、`credentials.bin`、`artifacts/` 和本机私人绝对路径。
- [ ] `.env.example` 的密钥字段为空。
- [ ] `pnpm test`、`pnpm typecheck`、`pnpm typecheck:mobile`、`pnpm lint`、`pnpm --filter @pa/desktop build` 在同一提交上有退出码。
- [ ] 没有把未执行的 Electron 主进程、Expo 真机或实况模型写成已验证。

还没有指定安全邮箱。不要在清单里临时编一个。

## 导出源码包

在干净工作区上：

```bash
git archive --format=tar.gz --prefix=zxb-bot/ -o zxb-bot-source.tgz HEAD
sha256sum zxb-bot-source.tgz
```

`git archive` 不包含 `.git`，也只包含已跟踪文件。

## 发布记录模板

```text
日期：
提交：
目标仓库：
源码包 SHA256：
pnpm test 退出码：
pnpm typecheck 退出码：
pnpm typecheck:mobile 退出码：
pnpm lint 退出码：
桌面生产构建退出码：
未执行：TypeScript Electron 主进程和 preload、Expo 真机或模拟器、实况模型
许可例外是否仍适用：
源码包是否含 .env、data、node_modules：否
```
