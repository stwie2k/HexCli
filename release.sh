#!/usr/bin/env bash
# HexCli 一键发布脚本
# 用法:
#   ./release.sh           # patch (1.0.0 -> 1.0.1)
#   ./release.sh minor     # minor (1.0.0 -> 1.1.0)
#   ./release.sh major     # major (1.0.0 -> 2.0.0)
#   ./release.sh beta      # 预览版 (1.0.0 -> 1.0.1-beta.0 或 1.0.1-beta.0 -> 1.0.1-beta.1)
#                          # 发布为 npm dist-tag=beta，不影响 latest

set -e

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major)
    NPM_TAG="latest"
    VERSION_CMD=("$BUMP")
    ;;
  beta)
    NPM_TAG="beta"
    # prerelease 会智能处理：
    #   3.1.6 → 3.1.7-beta.0（3.1.6 不含 prerelease tag，会先 patch 再加 beta.0）
    #   3.1.7-beta.0 → 3.1.7-beta.1
    VERSION_CMD=("prerelease" "--preid=beta")
    ;;
  *)
    echo "❌ 非法参数: $BUMP (允许 patch|minor|major|beta)"
    exit 1
    ;;
esac

cd "$(dirname "$0")"

# 1. 工作树必须干净
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作树有未提交改动，请先提交或 stash:"
  git status --short
  exit 1
fi

# # 2. 必须在 main 分支
# BRANCH=$(git rev-parse --abbrev-ref HEAD)
# if [ "$BRANCH" != "main" ]; then
#   echo "❌ 当前分支 $BRANCH，请切到 main 后再发版"
#   exit 1
# fi

# 3. 同步远端
echo "📡 拉取远端最新..."
git pull --rebase

# 4. bump 版本（自动创建 commit + tag）
echo "🔖 npm version ${VERSION_CMD[*]} ..."
NEW_VERSION=$(npm version "${VERSION_CMD[@]}" -m "release: %s")
echo "   → $NEW_VERSION"

# 5. publish（prepublishOnly 钩子会自动 build）
echo "📦 npm publish --tag $NPM_TAG ..."
if ! npm publish --tag "$NPM_TAG"; then
  echo "❌ publish 失败，回滚版本号与 tag"
  git tag -d "$NEW_VERSION" 2>/dev/null || true
  git reset --hard HEAD~1
  exit 1
fi

# 6. 推送到远端
echo "🚀 git push ..."
git push
git push --tags

echo ""
REGISTRY="${HEX_NPM_REGISTRY:-https://registry.npmjs.org}"
if [ "$NPM_TAG" = "beta" ]; then
  echo "✅ 预览版发布完成: @ali/hexcli@${NEW_VERSION#v} (dist-tag=beta)"
  echo "   预览安装: npm i -g @ali/hexcli@beta --registry=$REGISTRY"
  echo "   正式用户不受影响（latest 仍为上一个稳定版）"
else
  echo "✅ 发布完成: @ali/hexcli@${NEW_VERSION#v}"
  echo "   用户升级: hex update  或  npm i -g @ali/hexcli --registry=$REGISTRY"
fi
