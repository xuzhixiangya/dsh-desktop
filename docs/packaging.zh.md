# Silverstar 打包说明

这份说明给负责打安装包的人。发给同事的使用步骤写在安装包目录的《使用说明》里，这里只写怎么打出正确的包。

当前稳定版产品名是 **Silverstar**。版本号以 `dsh-plugin-desktop/package.json` 里的 `version` 为准，下面用 `2.0.17` 举例。

在仓库根目录执行命令。需要 Node.js `22.19+` 或 `24.x`，以及仓库自带的 Yarn `4.18.0`。第一次先准备好依赖：

```bash
git submodule update --init --recursive
corepack yarn install --immutable
```

Mac 安装包只能在 Mac 上打。Windows 安装包只能在 64 位 Windows 上打。

## 打完先检查

Mac 安装盘打开后，窗口里必须同时有这两样东西：

- `Silverstar.app`
- 一个指向「应用程序」的快捷方式

用户把 `Silverstar.app` 拖到「应用程序」上，软件才会出现在应用程序文件夹里。只把应用放进一个空磁盘，双击后软件能从磁盘里直接运行，但应用程序里找不到它。

在 Mac 上这样检查：

```bash
hdiutil attach -nobrowse -readonly -mountpoint /tmp/silverstar-dmg Silverstar-2.0.17-mac-arm64.dmg
ls -la /tmp/silverstar-dmg
hdiutil detach /tmp/silverstar-dmg
```

目录里要能看到 `Silverstar.app`，以及 `Applications -> /Applications`。看不到 `Applications`，这张盘就不能发出去。

Windows 要发的是安装程序 `Silverstar-<版本>-x64-Setup.exe`。用户走完安装向导后，开始菜单里会出现 Silverstar，第一次安装默认还会勾选桌面快捷方式。选「仅为我安装」时，程序在当前用户的 `AppData\Local\Programs\Silverstar`，不在 `C:\Program Files`，开始菜单里仍然有。

绿色版解压就能运行，不会进开始菜单。不要把它当成安装包发给别人。

## Mac

`package.json` 里的 Mac 目标默认是 `dir`，只会生成应用目录，不会生成安装盘。打安装包时必须使用下面的命令，它们会让 electron-builder 生成带「应用程序」快捷方式的 DMG。

### 内部试用，未签名

在 Mac 上，从仓库根目录执行：

```bash
# 一张盘同时包含苹果芯片和 Intel
corepack yarn dist:mac-smoke

# 只打当前这台苹果芯片电脑用的包
DSH_MAC_SMOKE_ARCH=arm64 corepack yarn dist:mac-smoke

# 只打 Intel
DSH_MAC_SMOKE_ARCH=x64 corepack yarn dist:mac-smoke
```

产物在 `dsh-plugin-desktop/dist/mac-smoke/`。这个目录每次都会先清空。文件名类似 `Silverstar-2.0.17-arm64.dmg` 或 `Silverstar-2.0.17-universal.dmg`。

这个包没有 Apple 开发者签名。别人的电脑第一次打开时，需要在图标上右键，选择「打开」。

### 正式发布，签名并公证

在已经配好 Apple 签名和公证的 Mac 上执行：

```bash
corepack yarn dist:mac
```

产物在 `dsh-plugin-desktop/dist/mac-release/`。这是一张通用安装盘，苹果芯片和 Intel 都能用。

### 应用已经打好，只重做安装盘

应用内容不用重编，只是上一张盘里缺少「应用程序」快捷方式时，在 `dsh-plugin-desktop` 目录执行。把 `<应用路径>` 换成 `Silverstar.app` 的绝对路径，把 `<输出目录>` 换成一个空目录。

苹果芯片：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY=1 \
node node_modules/electron-builder/cli.js \
  --mac dmg --arm64 \
  --prepackaged <应用路径> \
  --publish never \
  --config.mac.notarize=false \
  --config.npmRebuild=false \
  --config.directories.output=<输出目录> \
  --config.mac.artifactName='Silverstar-${version}-${os}-${arch}.${ext}' \
  --config.dmg.title=Silverstar
```

Intel 把 `--arm64` 换成 `--x64`。收尾检查会到 `<输出目录>/mac/Silverstar.app` 找 Intel 应用，所以 Intel 的 `--prepackaged` 要指向这个位置。苹果芯片对应的位置是 `<输出目录>/mac-arm64/Silverstar.app`。

打完后仍然按上面的方法挂载检查。磁盘里有 `Applications -> /Applications` 才算完成。

不要用磁盘工具或 `hdiutil` 把单独的 `Silverstar.app` 封成安装盘。那样做出来的盘里只有应用，没有「应用程序」快捷方式。

## Windows

在 64 位 Windows 上，从仓库根目录执行：

```powershell
corepack yarn dist:win
```

产物是 `dsh-plugin-desktop\dist\Silverstar-2.0.17-x64-Setup.exe`。这是 NSIS 安装程序。用户可以选择「仅为我安装」或「为所有用户安装」，可以改安装目录。安装后开始菜单里有 Silverstar，第一次安装默认勾选桌面快捷方式。卸载时会保留用户数据。

这个本地包没有代码签名。Windows 可能提示未知发布者或 SmartScreen，按使用说明选择「仍要运行」。

绿色版是另一条命令，不要和安装包混在一起发：

```powershell
corepack yarn dist:win-portable
```

## 放到安装包目录

复制到发给同事的目录时，可以改成使用说明里的文件名。只改文件名，不要重新做磁盘或安装程序。

| 发给同事的文件 | 谁用 |
| --- | --- |
| `Silverstar-2.0.17-mac-arm64.dmg` | 苹果芯片 Mac |
| `Silverstar-2.0.17-mac-x64.dmg` | Intel Mac |
| `Silverstar-2.0.17-win-x64-Setup.exe` | Windows |
| `reset-silverstar-macos.sh` | 要清空 Mac 上的 Silverstar 再重装 |
| `reset-silverstar-windows.ps1` | 要清空 Windows 上的 Silverstar 再重装 |

同一目录里放使用说明。Mac 用户打开对应的 dmg，把 Silverstar 拖到窗口里的「应用程序」。Windows 用户双击 Setup.exe，把安装向导走完。

清空脚本从仓库的 `scripts/reset-silverstar-macos.sh` 和 `scripts/reset-silverstar-windows.ps1` 原样复制，不要改文件名。用户把脚本下载到「下载」文件夹后，按使用说明里的那一行命令执行。脚本只删除已安装的软件和数据，不删除 dmg 和 Setup.exe。

## Beta

Beta 的产品名是 **Silverstar Beta**。对应命令是 `corepack yarn dist:mac:beta`、`corepack yarn dist:mac-smoke:beta` 和 `corepack yarn dist:win:beta`。不要把 Beta 安装包和稳定版放进同一个安装目录。
