# Silverstar

银星智能的桌面客户端，给 Windows 和 macOS 使用。员工用它写代码，也处理文档、表格和幻灯片。对话里的 Agent 自称 **Silverstar Agent**，由 **YX（银星智能）** 构建。用户用什么语言提问，思考和回复就用什么语言。

源码在 [https://cnb.cool/yxrobot/yx-desktop](https://cnb.cool/yxrobot/yx-desktop)。

稳定版窗口上的名字是 Silverstar，测试版是 Silverstar Beta。版本号以 [`dsh-plugin-desktop/package.json`](dsh-plugin-desktop/package.json) 里的 `version` 为准。

中文 · [English](README.en.md)

## 拿到代码

需要 Node.js `^22.19.0` 或 `>=24.0.0`。Yarn 用仓库锁定的 4.18.0，通过 Corepack 调用。

```sh
git clone https://cnb.cool/yxrobot/yx-desktop.git
cd yx-desktop
git submodule update --init --recursive
corepack yarn install --immutable
```

`deepseek-harness/` 是固定版本的上游子模块。桌面功能不要改里面的文件。

## 本地启动

第一次在这台机器上启动，或依赖和运行时都要重新准备：

```sh
corepack yarn dev
```

这条命令会刷新插件市场、准备 Agents Anywhere、编译桌面插件，然后打开窗口。通常要几分钟。日志里出现 `client ready` 后，窗口就可以用了。

代码已经编译过，只想再开一次窗口：

```sh
cd dsh-plugin-desktop
node lib/bin.js
```

改了 `dsh-plugin-desktop` 的源码，需要重新编译再开，但不用重新拉市场和 Agents Anywhere：

```sh
corepack yarn workspace dsh-plugin-desktop dev
```

测试版用 `corepack yarn dev:beta`。日常改桌面功能时，先改 `dsh-plugin-desktop-beta/`，再把共享改动同步到 `dsh-plugin-desktop/`。启动过程的细节见 [本地开发启动](docs/启动.md)。

## 仓库里有什么

| 目录 | 作用 |
| --- | --- |
| `dsh-plugin-desktop/` | 稳定版 Silverstar：窗口、托盘、打包 |
| `dsh-plugin-desktop-beta/` | 测试版 Silverstar Beta |
| `deepseek-harness/` | 固定版本的上游，功能分支不要改 |
| `docs/` | 架构和开发说明 |

本机数据目录仍叫 `YX Desktop`，测试版是 `YX Desktop Beta`。命令名是 `yx-desktop`。

## 和上游的关系

会话、工具和 Web 界面来自固定版本的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。本仓库在外面加桌面壳、公司账号、公司插件和 Silverstar 这个名字。

“DeepSeek Harness”是深度求索的商标。这里只用它说明技术来源。

## 文档

| 要做的事 | 入口 |
| --- | --- |
| 看启动为什么慢 | [本地开发启动](docs/启动.md) |
| 查架构和插件接口 | [文档索引](docs/README.md) |
| 看包级构建细节 | [包级参考](dsh-plugin-desktop/README.zh.md) |

## License

本项目遵循 [MIT License](LICENSE)。
