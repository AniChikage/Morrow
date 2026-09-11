#!/usr/bin/env bash
# Human-owned release script for Morrow's `local-script` release target.
#
# Morrow never writes or edits this file. The agent may only reference it by project-relative path in
# `release.propose`; Morrow copies it at proposal time, binds its SHA-256 into the review hash, and
# runs the sealed copy only after a human approves that exact version in 上线确认.
#
# Morrow supplies exactly these variables (plus PATH, HOME, NO_COLOR=1 and, only when the service
# itself has one, TMPDIR), never its own token or the rest of its environment:
#   MORROW_RELEASE_ID       the release this run belongs to
#   MORROW_ARTIFACT_PATH    sealed copy of the proposed artifact, here a release-manifest.json
#   MORROW_ARTIFACT_SHA256  its digest, echoed back in the receipt
#   MORROW_REVIEW_HASH      the approved review hash
#   MORROW_PROJECT_PATH     the project checkout (this run's git worktree source)
#   MORROW_RECEIPT_PATH     where to write the receipt JSON
#   MORROW_RUNTIME_CACHE    shared cache directory, reused for the Node 24 download
#
# Contract: exactly one line of receipt JSON on stdout (Morrow parses the last non-empty line) and the
# same JSON written to MORROW_RECEIPT_PATH. Every other message goes to stderr, where Morrow keeps the
# last 1 MiB as the release log. A failed gate reports status "failed" with a reason and exits non-zero.
# A published receipt also names the bundle it installed (installedBundle) and that bundle's own
# build fingerprint (buildFingerprint), read back from the installed build-info.json.
#
# This script never restarts the Morrow daemon or the Codex App, sends no signal and kills nothing. It
# only installs and reports. Morrow itself decides whether the receipt describes its own bundle and,
# if so, waits for its current work to finish before switching; a receipt without a readable
# fingerprint simply leaves the running version alone until a human switches it.
set -euo pipefail

: "${MORROW_RELEASE_ID:?MORROW_RELEASE_ID is required}"
: "${MORROW_ARTIFACT_PATH:?MORROW_ARTIFACT_PATH is required}"
: "${MORROW_ARTIFACT_SHA256:?MORROW_ARTIFACT_SHA256 is required}"
: "${MORROW_PROJECT_PATH:?MORROW_PROJECT_PATH is required}"
: "${MORROW_RECEIPT_PATH:?MORROW_RECEIPT_PATH is required}"

# The minimal environment may carry a short PATH; find the Node 24 the repository already requires.
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN=/usr/local/bin/node
else
  echo '{"status":"failed","reason":"node 24+ not found on PATH"}' >&2
  exit 1
fi
PATH="$(dirname "$NODE_BIN"):$PATH"
export PATH

COMMIT=''
VERSION=''
TEMP_ROOT=''
WORKTREE=''
STATUS=failed
REASON='脚本在完成前退出'
code=0
# Both stay empty until the install actually replaced the bundle, so a failed receipt claims neither.
INSTALLED_BUNDLE=''
BUILD_FINGERPRINT=''

emit() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [releaseId, artifactSha256, status, commit, version, reason, installedBundle, buildFingerprint] =
      process.argv.slice(1);
    const receipt = { releaseId, artifactSha256, status, commit, version, installedAt: new Date().toISOString() };
    if (reason) receipt.reason = reason;
    if (installedBundle) receipt.installedBundle = installedBundle;
    if (buildFingerprint) receipt.buildFingerprint = buildFingerprint;
    const line = JSON.stringify(receipt);
    fs.mkdirSync(require("node:path").dirname(process.env.MORROW_RECEIPT_PATH), { recursive: true });
    fs.writeFileSync(process.env.MORROW_RECEIPT_PATH, line + "\n");
    process.stdout.write(line + "\n");
  ' "$MORROW_RELEASE_ID" "$MORROW_ARTIFACT_SHA256" "$1" "$COMMIT" "$VERSION" "${2:-}" "$INSTALLED_BUNDLE" \
    "$BUILD_FINGERPRINT"
}

cleanup() {
  code=$?
  # Always give the temporary worktree back, whichever gate failed.
  if [ -n "$WORKTREE" ]; then
    git -C "$MORROW_PROJECT_PATH" worktree remove --force "$WORKTREE" >&2 || true
    git -C "$MORROW_PROJECT_PATH" worktree prune >&2 || true
  fi
  if [ -n "$TEMP_ROOT" ]; then rm -rf "$TEMP_ROOT"; fi
  if [ "$STATUS" != published ]; then
    emit failed "$REASON" || true
    if [ "$code" -eq 0 ]; then code=1; fi
  fi
  exit "$code"
}
trap cleanup EXIT

gate() {
  local label="$1"
  shift
  echo "== $label" >&2
  if ! "$@" >&2; then
    REASON="$label 未通过"
    exit 1
  fi
}
in_worktree() { (cd "$WORKTREE" && "$@"); }

# 1. The proposed artifact is the manifest; check its digest before trusting a single field.
ACTUAL_SHA="$(shasum -a 256 "$MORROW_ARTIFACT_PATH" | awk '{ print $1 }')"
if [ "$ACTUAL_SHA" != "$MORROW_ARTIFACT_SHA256" ]; then
  REASON='封存产物摘要与 MORROW_ARTIFACT_SHA256 不一致'
  exit 1
fi
if ! MANIFEST="$("$NODE_BIN" -e '
  const raw = require("node:fs").readFileSync(process.argv[1], "utf8");
  if (raw.length > 65536) throw new Error("manifest 超过 64 KiB");
  const data = JSON.parse(raw);
  for (const key of ["commit", "branch", "version", "sourceDigest"])
    if (typeof data[key] !== "string" || !data[key].trim()) throw new Error(`manifest 缺少字符串字段 ${key}`);
  if (!/^[0-9a-f]{7,40}$/.test(data.commit)) throw new Error("commit 不是十六进制 Git 对象名");
  if (!/^[0-9a-f]{16,128}$/.test(data.sourceDigest)) throw new Error("sourceDigest 不是十六进制摘要");
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(data.branch)) throw new Error("branch 名称无效");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$/.test(data.version)) throw new Error("version 不是语义化版本");
  process.stdout.write([data.commit, data.branch, data.version, data.sourceDigest].join("\n"));
' "$MORROW_ARTIFACT_PATH" 2>&1)"; then
  REASON="release-manifest.json 无效：$MANIFEST"
  exit 1
fi
COMMIT="$(printf '%s\n' "$MANIFEST" | sed -n 1p)"
BRANCH="$(printf '%s\n' "$MANIFEST" | sed -n 2p)"
VERSION="$(printf '%s\n' "$MANIFEST" | sed -n 3p)"
SOURCE_DIGEST="$(printf '%s\n' "$MANIFEST" | sed -n 4p)"
echo "== 发布 $MORROW_RELEASE_ID · $BRANCH@$COMMIT · $VERSION · 源指纹 $SOURCE_DIGEST" >&2

# 2. The commit has to exist in the project's own repository; nothing is fetched.
if ! git -C "$MORROW_PROJECT_PATH" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  REASON="提交 $COMMIT 不存在于 $MORROW_PROJECT_PATH"
  exit 1
fi

# 3. Build and test that exact commit in a throwaway detached worktree, never the live checkout. A
#    release runs on whatever else the machine is doing, so the service tests run one file at a time
#    (`--test-concurrency=1`): the gate must fail on the build, not on parallel timing. `npm test`
#    puts the file list first, where a later flag is ignored, so the runner is called directly.
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/morrow-release-XXXXXX")"
WORKTREE="$TEMP_ROOT/source"
gate "创建临时工作树" git -C "$MORROW_PROJECT_PATH" worktree add --detach "$WORKTREE" "$COMMIT"
WORKTREE_VERSION="$("$NODE_BIN" -e 'process.stdout.write(require(process.argv[1]).version)' "$WORKTREE/package.json")"
if [ "$WORKTREE_VERSION" != "$VERSION" ]; then
  REASON="manifest 版本 $VERSION 与该提交的 package.json 版本 $WORKTREE_VERSION 不一致"
  exit 1
fi

gate "安装依赖 npm ci" in_worktree npm ci
gate "类型检查 npm run typecheck" in_worktree npm run typecheck
gate "服务测试 node --test（串行）" in_worktree bash -c '"$0" --test --test-concurrency=1 tests/*.test.ts' "$NODE_BIN"
gate "打包 npm run build:app" in_worktree npm run build:app
gate "安装到 ~/Applications" in_worktree bash scripts/install-app.sh
INSTALLED_BUNDLE="$HOME/Applications/Morrow.app"

# 4. Read the freshly installed bundle's own build identity, so the receipt says which build is now on
#    disk. Best effort: an unreadable identity leaves the receipt without a fingerprint, which means
#    the running service keeps its version until a human switches it. It never fails an install.
if BUILD_FINGERPRINT="$("$NODE_BIN" -e '
  const data = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!/^[a-f0-9]{16,128}$/.test(data.fingerprint || "")) throw new Error("build-info.json 缺少运行指纹");
  process.stdout.write(data.fingerprint);
' "$INSTALLED_BUNDLE/Contents/Resources/build-info.json" 2>&1)"; then
  echo "== 已安装版本指纹 $BUILD_FINGERPRINT" >&2
else
  echo "== 未能读取安装版 build-info.json（$BUILD_FINGERPRINT）；回执不含运行指纹，本次需人工切换。" >&2
  BUILD_FINGERPRINT=''
fi

# 5. Export the real metrics for the weekly review. An export problem is reported but never rolls the
#    installed build back or turns an installed release into a failure; rerun `metrics` by hand.
mkdir -p "$MORROW_PROJECT_PATH/.morrow"
if in_worktree "$NODE_BIN" scripts/acceptance/run.ts metrics "$HOME/Library/Application Support/Morrow" \
  --out "$MORROW_PROJECT_PATH/.morrow/metrics.json" >&2; then
  echo '== 指标已导出到 .morrow/metrics.json' >&2
else
  echo '== 指标导出失败；已安装的版本保持不变，请在复盘前手动补跑 metrics 子命令。' >&2
fi

if [ -n "$BUILD_FINGERPRINT" ]; then
  echo '== 已安装；本脚本不重启任何进程。Morrow 自行核对回执后，会等当前工作结束再切换到新版本。' >&2
else
  echo '== 已安装；缺少运行指纹，切换运行中的 daemon 仍由人执行（暂停频道 → 退出界面 → 停 daemon → 重开）。' >&2
fi
STATUS=published
emit published
