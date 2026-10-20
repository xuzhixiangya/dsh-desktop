#!/bin/bash
# 给已经下载这个文件的用户。打开「终端」，粘贴下面这一行后回车：
#   bash "$HOME/Downloads/reset-silverstar-macos.sh"
# 会清掉本机已安装的 Silverstar 和数据。下载的安装包不会删除。

set -u

HOME_DIR="${HOME}"
APPS=(
  "/Applications/Silverstar.app"
  "/Applications/Silverstar Beta.app"
  "/Applications/DSH Desktop.app"
  "/Applications/DSH Desktop Beta.app"
  "${HOME_DIR}/Applications/Silverstar.app"
  "${HOME_DIR}/Applications/Silverstar Beta.app"
  "${HOME_DIR}/Applications/DSH Desktop.app"
  "${HOME_DIR}/Applications/DSH Desktop Beta.app"
)
DATA_DIRS=(
  "${HOME_DIR}/.dsh"
  "${HOME_DIR}/.dsh-beta"
  "${HOME_DIR}/Library/Application Support/YX Desktop"
  "${HOME_DIR}/Library/Application Support/YX Desktop Beta"
  "${HOME_DIR}/Library/Application Support/DSH Desktop"
  "${HOME_DIR}/Library/Application Support/DSH Desktop Beta"
  "${HOME_DIR}/Library/Application Support/Silverstar"
  "${HOME_DIR}/Library/Application Support/Silverstar Beta"
  "${HOME_DIR}/Library/Logs/YX Desktop"
  "${HOME_DIR}/Library/Logs/YX Desktop Beta"
  "${HOME_DIR}/Library/Logs/DSH Desktop"
  "${HOME_DIR}/Library/Logs/DSH Desktop Beta"
  "${HOME_DIR}/Library/Logs/Silverstar"
  "${HOME_DIR}/Library/Logs/Silverstar Beta"
  "${HOME_DIR}/Library/Caches/YX Desktop"
  "${HOME_DIR}/Library/Caches/YX Desktop Beta"
  "${HOME_DIR}/Library/Caches/DSH Desktop"
  "${HOME_DIR}/Library/Caches/DSH Desktop Beta"
  "${HOME_DIR}/Library/Caches/Silverstar"
  "${HOME_DIR}/Library/Caches/Silverstar Beta"
  "${HOME_DIR}/Library/Caches/ai.deepseek.dsh.desktop"
  "${HOME_DIR}/Library/Caches/ai.deepseek.dsh.desktop.beta"
  "${HOME_DIR}/Library/Saved Application State/ai.deepseek.dsh.desktop.savedState"
  "${HOME_DIR}/Library/Saved Application State/ai.deepseek.dsh.desktop.beta.savedState"
  "${HOME_DIR}/Library/HTTPStorages/ai.deepseek.dsh.desktop"
  "${HOME_DIR}/Library/HTTPStorages/ai.deepseek.dsh.desktop.beta"
  "${HOME_DIR}/Library/WebKit/ai.deepseek.dsh.desktop"
  "${HOME_DIR}/Library/WebKit/ai.deepseek.dsh.desktop.beta"
)
DATA_FILES=(
  "${HOME_DIR}/Library/Preferences/ai.deepseek.dsh.desktop.plist"
  "${HOME_DIR}/Library/Preferences/ai.deepseek.dsh.desktop.beta.plist"
)
KEYCHAIN_SERVICES=(
  "Silverstar Safe Storage"
  "Silverstar Beta Safe Storage"
  "YX Desktop Safe Storage"
  "Yx Desktop Safe Storage"
  "YX Desktop Beta Safe Storage"
  "DSH Desktop Safe Storage"
  "DSH Desktop Beta Safe Storage"
)
PROCESS_NAMES=(
  "Silverstar"
  "Silverstar Beta"
  "DSH Desktop"
  "DSH Desktop Beta"
  "Silverstar Helper"
  "Silverstar Helper (Renderer)"
  "Silverstar Helper (GPU)"
  "DSH Desktop Helper"
  "DSH Desktop Helper (Renderer)"
  "DSH Desktop Helper (GPU)"
)

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

remove_path() {
  local path="$1"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ -L "$path" ]]; then
    /bin/rm "$path" || { echo "未能删除: $path" >&2; return 1; }
    echo "已删除: $path"
    return 0
  fi
  /bin/rm -rf "$path" || { echo "未能删除: $path" >&2; return 1; }
  if [[ -e "$path" || -L "$path" ]]; then
    echo "未能删除: $path" >&2
    return 1
  fi
  echo "已删除: $path"
}

remove_named() {
  local directory="$1"
  local name="$2"
  local match
  [[ -d "$directory" ]] || return 0
  while IFS= read -r -d '' match; do
    remove_path "$match"
  done < <(find "$directory" -maxdepth 1 -name "$name" -print0)
}

echo "正在退出 Silverstar…"
for name in "Silverstar" "Silverstar Beta" "DSH Desktop" "DSH Desktop Beta"; do
  osascript -e "tell application \"${name}\" to quit" >/dev/null 2>&1 || true
done
sleep 1
for proc in "${PROCESS_NAMES[@]}"; do
  killall "$proc" >/dev/null 2>&1 || true
done
sleep 1
for app in "${APPS[@]}"; do
  [[ -d "$app" || -L "$app" ]] || continue
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done < <(pgrep -f "$app/" || true)
done

if [[ -x "$LSREGISTER" ]]; then
  for app in "${APPS[@]}"; do
    if [[ -d "$app" || -L "$app" ]]; then
      "$LSREGISTER" -u "$app" >/dev/null 2>&1 || true
    fi
  done
fi

echo "正在删除应用和数据…"
for path in "${APPS[@]}" "${DATA_DIRS[@]}" "${DATA_FILES[@]}"; do
  remove_path "$path"
done
remove_named "${HOME_DIR}/Library/Application Support/CrashReporter" "DSH Desktop_*.plist"
remove_named "${HOME_DIR}/Library/Application Support/CrashReporter" "Silverstar_*.plist"
remove_named "${HOME_DIR}/Library/Application Support/CrashReporter" "Silverstar Beta_*.plist"
remove_named "${HOME_DIR}/Library/Logs/DiagnosticReports" "DSH Desktop-*"
remove_named "${HOME_DIR}/Library/Logs/DiagnosticReports" "Silverstar-*"
remove_named "${HOME_DIR}/Library/Logs/DiagnosticReports" "Silverstar Beta-*"

echo "正在清除登录加密记录…"
for service in "${KEYCHAIN_SERVICES[@]}"; do
  while security delete-generic-password -s "$service" >/dev/null 2>&1; do
    echo "已清除钥匙串项: $service"
  done
done

tccutil reset All ai.deepseek.dsh.desktop >/dev/null 2>&1 || true
tccutil reset All ai.deepseek.dsh.desktop.beta >/dev/null 2>&1 || true

echo
echo "清除完成。下载的安装包没有删除。"
echo "现在可以重新安装 Silverstar。"
