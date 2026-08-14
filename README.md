# dsh-ntfy

DeepSeek Harness (DSH) host-plane 插件：当 agent **需要人工确认**（`approval/request`）或
**完成任务**（`agent/status` → `idle`）时，通过 [ntfy](https://ntfy.sh) 向手机推送通知。
功能对齐 Claude Code 的 `Notification(permission_prompt)` / `Stop` hook 埋点。

## 特性

- 监听 `approval/request`（需要确认）与 `agent/status`→`idle`（任务完成）两个 host 事件
- 只对**顶层会话**发「完成」通知，过滤 subagent 噪音
- 内置冷却：同一「项目 + 事件类型」在 `cooldownMs` 内只发一次
- 发送走 `ctx.get('subprocess')` 起 `/usr/bin/curl`，非阻塞、不打断审批 waterfall
- **全部标识符通过 `config` 配置，模块零硬编码，可直接分发**
- 通知正文携带**会话名称 + 短会话 id + 项目 + 工具/原因**，一个项目多会话也能一眼分辨

## 安装

前置：已有一个 ntfy 订阅（`https://ntfy.sh/<topic>`），以及一个 DSH profile
（默认在 `$DSH_HOME/profiles/<name>/`，`web` 是最常见的 name）。

### 方式 A：复制文件（无需发布，立即可用）

```bash
# 1. 获取本仓库
git clone https://github.com/hellosz/dsh-ntfy.git
cd dsh-ntfy

# 2. 把插件复制进你的 profile 目录（把 web 换成你的 profile 名）
PROFILE=web
install -m 0644 index.mjs "$DSH_HOME/profiles/$PROFILE/ntfy-notify.mjs"

# 3. 编辑 $DSH_HOME/profiles/$PROFILE/cordis.patch.yml，追加下方「配置」段
# 4. 重启 DSH
```

### 方式 B：作为 npm 依赖安装（发布到 npm 后可用）

```bash
cd "$DSH_HOME/profiles/$PROFILE"
pnpm add dsh-ntfy
# 然后 cordis.patch.yml 里把 name 写成 dsh-ntfy
```

## 配置（写入 cordis.patch.yml）

```yaml
- insert:
    - id: ntfy-notify
      name: ./ntfy-notify.mjs        # 方式 A；方式 B 用 dsh-ntfy
      config:
        topic: your-secret-topic   # 必填：你的 ntfy 主题名
        machine: my-machine        # 可选：默认取主机名
        server: https://ntfy.sh    # 可选：自建 ntfy 时改这里
        cooldownMs: 60000          # 可选：冷却毫秒
        notifyApproval: true       # 可选：需要确认通知
        notifyDone: true           # 可选：完成通知
```

改完重启 DSH 生效。

| 键 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `topic` | ✅ | — | ntfy 主题名（订阅 URL 最后一节）。缺失时插件记录错误并保持惰性，不影响 DSH 启动 |
| `server` | | `https://ntfy.sh` | ntfy 服务器地址 |
| `machine` | | `hostname()` | 通知标题里的机器名 |
| `cooldownMs` | | `60000` | 同项目同类通知最小间隔（毫秒） |
| `notifyApproval` | | `true` | 是否需要「需要确认」通知 |
| `notifyDone` | | `true` | 是否需要「完成」通知 |

## 触发时机

- **需要确认**：`approval/request` 事件。仅在 approval policy 为 `ask` 且确有审批请求时触发；
  `never` 模式下 DSH 直接拒绝、不产生审批，因此也不会有该通知（自洽）。
- **完成任务**：顶层会话 agent 回到 `idle`，与 approval policy 无关。
- `ask_user_question`（UI 选择题）是另一条路径，不在本插件范围内。

## 依赖

- DSH host 基础层提供的 `subprocess` 服务
- 系统 `PATH` 里的 `curl`

无第三方 npm 依赖。

## 发布（维护者）

打一个 `v*` 标签（如 `v1.0.0`）会触发 GitHub Actions 自动发布到 npm。

```bash
# 1. 在仓库 Settings → Secrets and variables → Actions 里配 NPM_TOKEN
#    （npm 的 Automation access token）
# 2. 本地升版本并打标签（会自动改 package.json 的 version、提交并打 tag）
npm version patch   # 或 minor / major
git push --follow-tags
```

首次发布前确认：`dsh-ntfy` 包名在 npm 上可用，且本机已 `npm login`。

## License

MIT
