#!/usr/bin/env bash
# 清掉 iCloud 同步造出来的重复文件。
#
# 这个仓库在 ~/Desktop 下，而 ~/Desktop 是 iCloud 同步目录。iCloud 判定冲突时
# 会在原文件旁边物化出一份 `名字 2.ext`、`名字 3.ext`……它们是**真实存在的文件**，
# 于是：
#   · Kotlin 把 `ApiErrorBody 2.kt` 当第二份声明编译 → Conflicting overloads，构建挂
#   · Gradle 的测试扫描器捡到 `XxxTest 4.class` → Could not execute test class，测试红
#   · TypeScript 把 `ical 3.ts` 一起编译 → 重复声明
# 而且它是间歇性的：清掉能过，过一会儿 iCloud 又物化一份，看上去像工具链抽风。
#
# ⚠️ 这个脚本以前只清 `* 2*`。实测残留里后缀 3 有 739 个、4 有 439 个、
#    5 有 56 个、6 有 4 个 —— 也就是说它一直只清掉了一小部分，
#    而人以为自己清干净了。这正是「跑了、绿了、洞还开着」。
#
# 匹配收窄成 `名字 <数字>` 和 `名字 <数字>.后缀` 两种形状（以前的 `* 2*`
# 会连 `foo 2bar.txt` 这种正常文件一起删掉）。用 -name 的通配而不是 -regex，
# 因为 BSD find（macOS）和 GNU find（CI）的 -regex 用法不一样。

set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  -name '* [0-9]'      -o -name '* [0-9].*'
  -o -name '* [0-9][0-9]' -o -name '* [0-9][0-9].*'
)

# 统计一下再删，好让人看见「这次清掉了多少」——数字忽然变大意味着
# iCloud 正在跟某个目录较劲，值得去看一眼而不是每次机械地清。
count=$(find . \( "${patterns[@]}" \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | wc -l | tr -d ' ')

if [ "$count" != "0" ]; then
  find . \( "${patterns[@]}" \) \
    -not -path '*/node_modules/*' -not -path '*/.git/*' -delete 2>/dev/null || true
fi

find . -name '.DS_Store' -not -path '*/node_modules/*' -delete 2>/dev/null || true

echo "清掉 ${count} 个 iCloud 重复文件"
