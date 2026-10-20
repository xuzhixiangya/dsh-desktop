# Silverstar

The YX desktop client for Windows and macOS. People use it for software engineering and for office work such as documents, spreadsheets, and slide decks. In chat, the agent introduces itself as **Silverstar Agent**, built by **YX（银星智能）**. It thinks and replies in the language of the user's message.

Source: [https://cnb.cool/yxrobot/yx-desktop](https://cnb.cool/yxrobot/yx-desktop).

The stable app is named Silverstar. The beta app is named Silverstar Beta. The version is the `version` field in [`dsh-plugin-desktop/package.json`](dsh-plugin-desktop/package.json).

[中文](README.md) · English

## Get the code

Use Node.js `^22.19.0` or `>=24.0.0`. Yarn is the repository's pinned 4.18.0 release, invoked through Corepack.

```sh
git clone https://cnb.cool/yxrobot/yx-desktop.git
cd yx-desktop
git submodule update --init --recursive
corepack yarn install --immutable
```

`deepseek-harness/` is a pinned upstream submodule. Do not edit it from a desktop feature branch.

## Run locally

The first launch on a machine, or any launch that must refresh dependencies and the runtime:

```sh
corepack yarn dev
```

That refreshes the plugin market, prepares Agents Anywhere, builds the desktop plugin, and then opens the window. It usually takes several minutes. The window is ready after the log line `client ready`.

When the code is already built and you only want the window again:

```sh
cd dsh-plugin-desktop
node lib/bin.js
```

After editing `dsh-plugin-desktop`, rebuild and open the window without refreshing the market or Agents Anywhere:

```sh
corepack yarn workspace dsh-plugin-desktop dev
```

Use `corepack yarn dev:beta` for the beta app. Develop shared desktop changes in `dsh-plugin-desktop-beta/` first, then synchronize them into `dsh-plugin-desktop/`. The startup sequence is described in [Local development startup](docs/启动.md) (Chinese).

## What is in this repository

| Directory | Role |
| --- | --- |
| `dsh-plugin-desktop/` | Stable Silverstar: window, tray, and packaging |
| `dsh-plugin-desktop-beta/` | Beta Silverstar Beta |
| `deepseek-harness/` | Pinned upstream checkout; leave it unchanged on feature branches |
| `docs/` | Architecture and development notes |

The on-disk data directory remains `YX Desktop`. The beta directory is `YX Desktop Beta`. The command name is `yx-desktop`.

## Upstream

Sessions, tools, and the Web interface come from a pinned [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout. This repository adds the desktop shell, the company account, the company plugins, and the Silverstar name.

“DeepSeek Harness” is a trademark of DeepSeek. It is used here only to identify the technical source.

## Documentation

| Task | Entry |
| --- | --- |
| See why startup takes time | [Local development startup](docs/启动.md) (Chinese) |
| Architecture and plugin interfaces | [Documentation index](docs/README.en.md) |
| Package build details | [Package reference](dsh-plugin-desktop/README.md) |

## License

This project is licensed under the [MIT License](LICENSE).
