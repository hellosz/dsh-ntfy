/**
 * dsh-ntfy — DeepSeek Harness (DSH) host-plane 通知插件。
 *
 * 监听两个 host 事件：
 *   - approval/request          需要人工确认
 *   - agent/status -> idle      任务完成（仅顶层会话，过滤 subagent 噪音）
 *
 * 通知正文携带：会话名称（session title）+ 短会话 id + 项目 + 工具/原因，便于多会话判断。
 *
 * 全部标识符通过 row 的 config 传入，模块本身不含任何硬编码的个人 topic / 机器名：
 *   topic         (必填) ntfy 主题名
 *   server        (可选) 默认 https://ntfy.sh
 *   machine       (可选) 默认取主机名 hostname()
 *   cooldownMs    (可选) 默认 60000
 *   notifyApproval(可选) 默认 true
 *   notifyDone    (可选) 默认 true
 *
 * 依赖：host 基础层提供的 subprocess / sessionTitle 服务 + 系统 /usr/bin/curl。无第三方依赖。
 */
import { hostname } from 'node:os'

export default {
  name: 'dsh-ntfy',

  apply(ctx, config = {}) {
    const subprocess = ctx.get('subprocess')
    const sessionTitle = ctx.get('sessionTitle')

    const topic = typeof config.topic === 'string' ? config.topic.trim() : ''
    if (!topic) {
      console.error('[dsh-ntfy] 未配置 topic：请在 cordis.patch.yml 该行 config 中设置 ntfy 主题名，例如 config: { topic: "my-topic" }')
      return
    }

    const server = String(config.server || 'https://ntfy.sh').replace(/\/+$/, '')
    const machine = String(config.machine || hostname())
    const cooldownMs = typeof config.cooldownMs === 'number' ? config.cooldownMs : 60000
    const notifyApproval = config.notifyApproval !== false
    const notifyDone = config.notifyDone !== false
    const url = server + '/' + topic

    const lastSent = new Map()

    function cooled(key) {
      const now = Date.now()
      const prev = lastSent.get(key)
      if (prev !== undefined && now - prev < cooldownMs) return true
      lastSent.set(key, now)
      return false
    }

    function projectOf(agent) {
      let cwd = ''
      let id = ''
      try {
        const header = agent && agent.session && agent.session.header
        cwd = (header && header.cwd) || ''
        id = (agent && agent.id) || ''
      } catch (_) {}
      if (cwd) {
        const parts = String(cwd).split('/').filter(Boolean)
        return parts.length ? parts[parts.length - 1] : String(cwd)
      }
      return id ? String(id) : 'unknown'
    }

    // 会话标签：优先取会话名称（session title），并附短 id 便于同一项目多会话区分
    function sessionLabel(agent) {
      let title = ''
      let id = ''
      try { id = (agent && agent.id) || '' } catch (_) {}
      try {
        if (sessionTitle !== undefined) {
          const snap = sessionTitle.get(agent && agent.session)
          title = (snap && snap.title) || ''
        }
      } catch (_) {}
      const shortId = id ? String(id).slice(0, 8) : ''
      if (title) return shortId ? title + ' #' + shortId : title
      return shortId ? '#' + shortId : 'unknown'
    }

    function send(title, priority, tags, body) {
      if (subprocess === undefined) {
        console.error('[dsh-ntfy] subprocess 服务不可用，无法发送通知')
        return
      }
      const argv = [
        '/usr/bin/curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
        '--max-time', '10',
        '-H', 'Title: ' + title,
        '-H', 'Priority: ' + priority,
        '-H', 'Tags: ' + tags,
        '-d', body,
        url,
      ]
      try {
        const handle = subprocess.spawn({
          argv,
          cwd: '/tmp',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
          graceMs: 15000,
        })
        if (handle && handle.done) {
          handle.done.then(
            () => {
              try {
                const out = handle.collected && handle.collected.stdout
                const code = out ? String(out.readFrom(0).text).trim() : ''
                if (code !== '200') console.error('[dsh-ntfy] 返回 HTTP ' + code + ' — ' + title)
              } catch (err) {
                console.error('[dsh-ntfy] 读取结果失败: ' + (err && err.message))
              }
            },
            (err) => { console.error('[dsh-ntfy] 进程启动失败: ' + (err && err.message)) },
          )
        }
      } catch (err) {
        console.error('[dsh-ntfy] 发送异常: ' + (err && err.message))
      }
    }

    if (notifyApproval) {
      ctx.on('approval/request', (req, next) => {
        try {
          const tool = (req && req.toolName) || 'unknown'
          const reason = (req && req.reason) || ''
          const proj = projectOf(req && req.agent)
          const sess = sessionLabel(req && req.agent)
          if (!cooled('approval:' + proj)) {
            const lines = ['会话: ' + sess, '项目: ' + proj, '工具: ' + tool]
            if (reason) lines.push('原因: ' + reason)
            send(machine + ' [dsh]: 需要确认', 'high', 'warning,dsh,' + machine, lines.join('\n'))
          }
        } catch (err) {
          console.error('[dsh-ntfy] approval 处理异常: ' + (err && err.message))
        }
        return next()
      })
    }

    if (notifyDone) {
      ctx.on('agent/status', (payload) => {
        try {
          if (!payload || payload.status !== 'idle') return
          const agent = payload.agent
          let depth = 0
          try { depth = agent && agent.session && agent.session.header && agent.session.header.delegationDepth } catch (_) {}
          if (depth) return
          const proj = projectOf(agent)
          const sess = sessionLabel(agent)
          if (!cooled('done:' + proj)) {
            send(
              machine + ' [dsh]: 完成',
              'default',
              'white_check_mark,dsh,' + machine,
              '会话: ' + sess + '\n项目: ' + proj + '\n状态: 等待输入',
            )
          }
        } catch (err) {
          console.error('[dsh-ntfy] status 处理异常: ' + (err && err.message))
        }
      })
    }

    console.log('[dsh-ntfy] 已激活: ' + url + ' (machine=' + machine + ')')
  },
}
