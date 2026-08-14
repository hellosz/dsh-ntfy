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

## 安装（两步）

1. 把 `index.mjs` 放到 profile 目录（与 `cordis.patch.yml` 同级）；或 `pnpm add dsh-ntfy` 后按包名引用。
2. 在 `cordis.patch.yml` 追加一行 `insert`：

```yaml
- insert:
    - id: ntfy-notify
      name: ./index.mjs        # 或包名 dsh-ntfy
      config:
        topic: your-secret-topic   # 必填：你的 ntfy 主题名
        machine: my-machine        # 可选：默认取主机名
        server: https://ntfy.sh    # 可选：自建 ntfy 时改这里
        cooldownMs: 60000          # 可选：冷却毫秒
        notifyApproval: true       # 可选：需要确认通知
        notifyDone: true           # 可选：完成通知
```

重启 DSH 生效。

## 配置

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

## License

MIT
