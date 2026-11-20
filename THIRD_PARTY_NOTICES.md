# 第三方声明

本文件只覆盖仓库源码之外、由 `pnpm-lock.yaml` 安装进来的依赖，以及安装后才会下载的运行时二进制。它不是法律审计。`package.json` 里的 `"license": "MIT"` 只表示本仓库中 Xiaobin Zeng 有权开放的原创源码和文档；它不把第三方代码重新许可成 MIT。

统计范围是按 `pnpm-lock.yaml` 在当前平台安装后的包：只读取这些已安装包 `package.json` 的 `license` 字段，并对照锁文件中的版本。锁文件还列出其他操作系统和 CPU 的可选二进制，那些包不会在每一台机器上安装，所以这里不写一个跨平台的包总数。没有逐份阅读每个依赖的许可证全文，也没有审查原生 SDK、应用商店或操作系统自带组件。

## 直接依赖

| 包                                                                  | 锁定版本                        | 声明的许可证                   |
| ------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| react / react-dom                                                   | 18.3.1                          | MIT                            |
| scheduler                                                           | 0.23.2                          | MIT                            |
| zod                                                                 | 4.6.7                           | MIT                            |
| ws                                                                  | 8.18.3                          | MIT                            |
| better-sqlite3                                                      | 13.2.0                          | MIT                            |
| @langchain/core                                                     | 1.4.2                           | MIT                            |
| @langchain/langgraph                                                | 1.7.5                           | MIT                            |
| @langchain/langgraph-checkpoint                                     | 1.2.3                           | MIT                            |
| @langchain/langgraph-checkpoint-sqlite                              | 1.1.1                           | MIT                            |
| @langchain/openai                                                   | 1.8.4                           | MIT                            |
| expo                                                                | 52.0.47                         | MIT                            |
| expo-router                                                         | 4.0.21                          | MIT                            |
| expo-constants / expo-linking / expo-secure-store / expo-status-bar | 17.0.8 / 7.0.5 / 14.0.1 / 2.0.1 | MIT                            |
| react-native                                                        | 0.76.9                          | MIT                            |
| react-native-web                                                    | 0.19.13                         | MIT                            |
| @babel/runtime                                                      | 7.26.10                         | MIT                            |
| query-string                                                        | 7.1.3                           | MIT                            |
| electron                                                            | 33.4.11                         | npm 包字段为 MIT；二进制见下文 |
| vite                                                                | 6.4.1                           | MIT                            |
| typescript                                                          | 5.9.3                           | Apache-2.0                     |
| @biomejs/biome                                                      | 2.6.8                           | MIT OR Apache-2.0              |
| tsx                                                                 | 4.20.6                          | MIT                            |

仓库没有提交字体文件、图标字体、图片或设计模板。界面只在 CSS 里把 `Noto Sans SC` 和 `PingFang SC` 写成系统字体回退名称，没有打包这些字体。`PingFang` 是苹果的字体名称，这里没有复制字体文件。

## 传递依赖里需要单独保留的许可证

大多数传递依赖的 `license` 字段是 MIT、ISC、BSD-2-Clause、BSD-3-Clause、Apache-2.0、0BSD、BlueOak-1.0.0 或 Unlicense。下面这些不能被仓库的 MIT 覆盖：

| 包                                       | 版本         | 声明                               | 处理                                                                            |
| ---------------------------------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| lightningcss、lightningcss-linux-x64-gnu | 1.27.0       | MPL-2.0                            | 这些文件继续适用 MPL-2.0。修改它们时要按 MPL 提供对应源码。                     |
| caniuse-lite                             | 1.0.30001826 | CC-BY-4.0                          | 数据文件需要保留署名，不能改写成 MIT。                                          |
| node-forge                               | 1.4.3        | BSD-3-Clause OR GPL-2.0            | 双许可。本项目选择 BSD-3-Clause 这一支，不选择 GPL-2.0。                        |
| rc                                       | 1.2.8        | BSD-2-Clause OR MIT OR Apache-2.0  | 多许可，不需要接受其中最严格的一支。                                            |
| argparse                                 | 2.0.1        | Python-2.0                         | 保留 Python 2.0 许可，不改成 MIT。                                              |
| qrcode-terminal                          | 0.11.0       | `licenses` 字段写着 Apache 2.0     | 元数据格式不标准，但指向 Apache-2.0。                                           |
| readline                                 | 1.3.0        | 字段只写 `BSD`                     | 已核对发布包和上游历史，仍不能确定 2-Clause 或 3-Clause。见下文，未改写其许可。 |
| @segment/loosely-validate-event          | 2.0.0        | `package.json` 没有 `license` 字段 | 包内 `LICENSE` 是 MIT，版权 2017 Segment.io。以该文件为准，不要只看空字段。     |
| requireg                                 | 0.2.2        | 字段写成带引号的 `"MIT"`           | 仍是 MIT 声明，格式不干净。                                                     |

`node_modules` 不进入源码包。安装时由锁文件取回上述包及其原文版权声明。

## readline@1.3.0

本仓库的命令行使用 Node 内置的 `node:readline`，不引用 npm 包 `readline`。锁文件里的 `readline@1.3.0` 只出现在 `@react-native/community-cli-plugin@0.76.9` 的依赖声明中。检查该插件已安装文件，除 `package.json` 外没有 `require("readline")`。Node 会把 `require("readline")` 解析到内置模块，因此这个 npm 包通常不会被这条路径加载。

已核对的发布材料：

- 本机安装目录只有 `package.json`、`readline.js`、`README.md` 和 `test/`，没有 `LICENSE` 文件。`package.json` 的 `license` 是 `BSD`。
- npm 注册表 `https://registry.npmjs.org/readline/1.3.0` 同样只写 `BSD`。该版本发布于 2015-12-28。
- 对应上游提交 `7a6b5a5dd4475ebcead43d5e421a0c22734162a7`（信息为 “bump vers”）的 `package.json` 也是 `"license": "BSD"`。
- README 只写 “BSD © Craig Brookes”，没有 2-Clause 或 3-Clause 文本。
- 2025-03-19，作者提交 `2dab026975304c627a1869b9a6b8e1ec41377f34` 添加 Apache-2.0 的 `LICENSE`，提交 `06ad3d0716b1356967e2d058487f627db461a75e` 把 `package.json` 改成 `apache-2.0`。GitHub 议题 maleck13/readline#26 说明这还没有发布成新的 npm 版本。

因此不能把已经安装的 1.3.0 改记成 Apache-2.0，也不能猜它是哪一条 BSD。没有从锁文件删掉它：它仍是该 React Native 插件声明的依赖，删掉会改变安装图，而 Expo 命令行不在本次测试范围内。这不是源码包里的再许可，而是安装后仍会带上的一个条款未写清的传递依赖。

## Electron、Expo 和 React Native 的边界

这次只读了 npm 包的 `license` 字段，以及本仓库有没有把二进制提交进来。没有打开并审完下列发行物：

- Electron 安装时下载的可执行文件，以及其中的 Chromium、`LICENSES.chromium.html` 和其他捆绑组件。
- Expo 预编译模块、预构建原生工程、Android SDK、iOS SDK、Gradle 和 CocoaPods 依赖。
- React Native 真机或模拟器构建产物。

`electron@33.4.11` 的 npm 字段是 MIT，不能据此说 Electron 二进制也是 MIT。Expo 和 React Native 的 JavaScript 包字段大多是 MIT，不能据此说它们的原生发行物已经审完。本仓库没有提交这些二进制，本次也没有做真机构建。

better-sqlite3 的 npm 包是 MIT。它在安装时编译原生模块；编译依赖本机工具链，不把 SQLite 的源码树提交到本仓库。SQLite 本身是公有领域，但本清单没有把编译产物的通知文件复制进来。

## 源码来源

网关、账本、运行时、SDK、命令行、桌面和手机界面是为本项目写的。演示夹具 `fixtures/` 是原创的无敏感示例，含测试哨兵字符串。没有把教程仓库或第三方应用源码整段拷进本仓库后再改许可证。依赖只通过包管理器引用，不把它们的版权改成 2026 Xiaobin Zeng。
