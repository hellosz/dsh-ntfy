/**
 * dsh-ntfy — DeepSeek Harness (DSH) host-plane 通知插件。
 *
 * 监听两个 host 事件：
 *   - approval/request          需要人工确认
 *   - agent/status -> idle      任务完成（仅顶层会话，过滤 subagent 噪音）
 *
 * 通知正文携带：会话标题 + 短 id + 最近一条用户消息（当前任务原文）+ 项目 + 工具/原因，
 * 便于一个项目多个会话时一眼分辨。
 *
 * 全部标识符通过 row 的 config 传入，模块本身不含任何硬编码的个人 topic / 机器名：
 *   topic         (必填) ntfy 主题名
 *   server        (可选) 默认 https://ntfy.sh
 *   machine       (可选) 默认取主机名 hostname()
 *   cooldownMs    (可选) 默认 60000
 *   notifyApproval(可选) 默认 true
 *   notifyDone    (可选) 默认 true
 *
 * 依赖：host 基础层提供的 subprocess 服务 + 系统 /usr/bin/curl。无第三方依赖。
 * 会话信息直接从 agent.session.events 同步读取，无需额外服务。
 */
import { hostname } from 'node:os'

export default {
  name: 'dsh-ntfy',

  apply(ctx, config = {}) {
    const subprocess = ctx.get('subprocess')

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
      try {
        const h = agent && agent.session && agent.session.header
        cwd = (h && h.cwd) || ''
      } catch (_) {}
      if (cwd) {
        const parts = String(cwd).split('/').filter(Boolean)
        return parts.length ? parts[parts.length - 1] : String(cwd)
      }
      return 'unknown'
    }

    // 从会话事件日志同步取：标题（session/title）+ 最近一条用户消息（当前任务）
    function contextOf(agent) {
      const c = { title: '', task: '', shortId: '' }
      try { c.shortId = agent && agent.id ? String(agent.id).slice(0, 8) : '' } catch (_) {}
      try {
        const events = agent && agent.session && agent.session.events
        if (Array.isArray(events)) {
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (!ev || !ev.data) continue
            if (!c.title && ev.type === 'session/title') {
              c.title = String(ev.data.title || '')
            }
            if (!c.task && ev.type === 'user/message') {
              const content = ev.data.content
              if (Array.isArray(content)) {
                let t = ''
                for (let j = 0; j < content.length; j++) {
                  const b = content[j]
                  if (b && typeof b.text === 'string') t += b.text
                }
                t = t.replace(/\s+/g, ' ').trim()
                if (t && t.charAt(0) !== '<') {
                  c.task = t.length > 140 ? t.slice(0, 140) + '…' : t
                }
              }
            }
            if (c.title && c.task) break
          }
        }
      } catch (_) {}
      return c
    }

    function labelOf(c) {
      if (c.title) return c.title + (c.shortId ? ' #' + c.shortId : '')
      return c.shortId ? '#' + c.shortId : 'unknown'
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
          const agent = req && req.agent
          const tool = (req && req.toolName) || 'unknown'
          const reason = (req && req.reason) || ''
          const proj = projectOf(agent)
          const c = contextOf(agent)
          if (!cooled('approval:' + proj)) {
            const lines = ['会话: ' + labelOf(c), '项目: ' + proj]
            if (c.task) lines.push('任务: ' + c.task)
            lines.push('工具: ' + tool)
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
          const c = contextOf(agent)
          if (!cooled('done:' + proj)) {
            const lines = ['会话: ' + labelOf(c), '项目: ' + proj]
            if (c.task) lines.push('任务: ' + c.task)
            lines.push('状态: 等待输入')
            send(machine + ' [dsh]: 完成', 'default', 'white_check_mark,dsh,' + machine, lines.join('\n'))
          }
        } catch (err) {
          console.error('[dsh-ntfy] status 处理异常: ' + (err && err.message))
        }
      })
    }

    console.log('[dsh-ntfy] 已激活: ' + url + ' (machine=' + machine + ')')
  },
}
