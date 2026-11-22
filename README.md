# dsh-esp-bridge

给 **ESP32 语音终端**用的 DSH HTTP 桥插件。

它把一条文字请求投进电脑上正在运行的 DSH 会话，等 agent 回答完，再把回答通过 HTTP 返回。适合 ESP32、浏览器、手机或任何能发 HTTP 请求的设备。

> 插件本身不新开端口，而是把 `/esp/*` 路由注册到 DSH 自己的 web 服务器上。

## 功能

| 路由 | 方法 | 作用 |
|---|---|---|
| `/esp/ping` | GET | 自检：服务是否在、sessionsRoot、活跃会话 |
| `/esp/ask?text=...` | GET | 向 DSH 投一句话并等待回答 |
| `/esp/ask` | POST | JSON 请求：`{"text":"...","sessionId":"..."}` |
| `/esp/stream?text=...` | GET | 流式返回 NDJSON，边生成边推送 |
| `/esp/last` | GET | 补捞之前投递但还没取走的回答 |
| `/esp/dump?n=8` | GET | 查看当前会话最后 N 条事件，调试用 |
| `/esp/debug` | GET | 查看 agents 服务、会话探测信息 |
| `/esp/newvoice` | GET | 从指定会话/目录复制上下文，新建一个语音会话 |

所有响应都是 JSON（`/esp/stream` 是 NDJSON）。默认允许跨域 `Access-Control-Allow-Origin: *`。

## 安装

### 1. 放到 DSH 插件目录

把整个目录放到：

```text
%USERPROFILE%\.dsh\plugins\dsh-esp-bridge
```

Windows 下通常是：

```text
C:\Users\<你>\.dsh\plugins\dsh-esp-bridge
```

### 2. 注册到 DSH profile

编辑你的 profile（例如 `%USERPROFILE%\.dsh\profiles\desktop\package.json`），在 `dependencies` 和 `dsh.profile.bundles` 里各加一项：

```json
{
  "dependencies": {
    "dsh-esp-bridge": "link:C:/Users/<你>/.dsh/plugins/dsh-esp-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-esp-bridge"
      ]
    }
  }
}
```

> 路径里的斜杠用 `/` 或 `\\` 都可以；不要写成单个 `\`。

### 3. 重启 DSH

重启后插件会自动加载。日志默认写到：

```text
%USERPROFILE%\.dsh\esp-bridge.log
```

看到下面这行就说明注册成功：

```text
esp-bridge 已注册路由 /esp，sessionsRoot=...
```

## 配置

配置文件是 `cordis.patch.yml`。所有选项都可选：

```yaml
- insert:
    - id: esp-bridge
      name: dsh-esp-bridge
      config:
        # sessionsRoot: 'C:\\Users\\you\\.dsh\\sessions'
        # sessionId: ''
        # authToken: 'change-me'
        waitMs: 180000
        # logFile: 'C:\\Users\\you\\.dsh\\esp-bridge.log'
        # personaPath: 'C:\\Users\\you\\.dsh\\esp-persona.txt'
        # cwd: 'C:\\Users\\you\\workspace'
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `sessionsRoot` | `~/.dsh/sessions` | 会话根目录；会递归扫描一层 workspace 目录 |
| `sessionId` | 空 | 固定投递到某个会话；空则选最新的活跃会话 |
| `waitMs` | `180000` | 等待回答的最长时间（毫秒） |
| `logFile` | `~/.dsh/esp-bridge.log` | 日志文件 |
| `personaPath` | `~/.dsh/esp-persona.txt` | `/esp/newvoice` 使用的人格提示词文件；不存在则忽略 |
| `cwd` | 当前进程目录 | 新建语音会话时使用的工作目录，建议显式设置 |
| `authToken` | 空 | 可选的 Bearer Token；设置后所有 `/esp/*` 请求都要带 `Authorization: Bearer ...` 或 `?token=...` |

## 使用示例

### 自检

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8124/esp/ping
```

### GET 投一句话

```bash
curl "http://127.0.0.1:8124/esp/ask?text=你好，帮我看看今天的待办"
```

### POST 投一句话

```bash
curl -X POST "http://127.0.0.1:8124/esp/ask" \
  -H "Content-Type: application/json" \
  -d '{"text":"你好，帮我看看今天的待办"}'
```

### 指定会话

```bash
curl -X POST "http://127.0.0.1:8124/esp/ask" \
  -H "Content-Type: application/json" \
  -d '{"text":"继续上一个任务","sessionId":"你的-session-id"}'
```

### 流式返回

```bash
curl -N "http://127.0.0.1:8124/esp/stream?text=写一个一句话笑话"
```

返回一行一个 JSON：

```json
{"delta":"..."}
{"done":true,"ok":true,"text":"...","sessionId":"..."}
```

## ESP32 示例

见 [`examples/esp32_http_client.ino`](examples/esp32_http_client.ino)。

要点：

- ESP32 和电脑要在同一网络，或通过 Tailscale/反向代理互通。
- 插件路由挂在 DSH web 服务器上；如果 DSH 只监听 `127.0.0.1`，你需要先把端口暴露到局域网：
  - 用 `dsh-phone-remote` 的 bridge（默认 `8124`）做反向代理；
  - 或者用 `netsh interface portproxy` / Caddy / nginx 把 `8124` 暴露到 LAN IP；
  - 或者在 ESP32 上跑 Tailscale（较复杂）。
- 不要把 `8124` 直接暴露到公网；插件默认没有鉴权。

## 安全提醒

- `/esp/*` 默认 **没有 token 鉴权**，且 CORS 为 `*`。
- 只建议在可信局域网、Tailscale tailnet 或带额外认证的反向代理后面使用。
- 如果要公网访问，至少加一层：
  - 反向代理 Basic Auth / Bearer Token；
  - 或 Tailscale Serve + tailnet ACL；
  - 或只允许指定源 IP。
- DSH 的 `webServer` / `agents` 属于内部 API，DSH 升级后插件可能需要适配。

## 兼容性

- Node.js `>=22.15`（使用 `node:zlib` 的 zstd 解压）。
- 适用于通过 `webServer` 注册路由、通过 `agents` 访问会话的 DSH 版本。
- 已在 Windows + DSH 桌面版环境验证。

## 同类项目

- [jimyddd01-coder/dsh-dafeiyu-butler](https://github.com/jimyddd01-coder/dsh-dafeiyu-butler) — DSH 家庭 AI 插件集合，含 persona、家庭记忆、Home Assistant、天气、语音桥和 ESP32 语音终端固件（最接近本项目）
- [DoYitNow/esp32-rlcd-dsh-agent](https://github.com/DoYitNow/esp32-rlcd-dsh-agent) — ESP32-S3-RLCD-4.2 语音/状态终端，通过 USB/Wi-Fi 接 DSH
- [hydra-eng/VENUS](https://github.com/hydra-eng/VENUS) — ESP32 + 本地 DeepSeek + Windows 自动化 + Home Assistant 的离线语音助手生态
- [slinxiaosun-blip/dsh-ai-passport-plugin](https://github.com/slinxiaosun-blip/dsh-ai-passport-plugin) — DSH 任务终端：蓝牙链路、任务桥接、语音识别、桌面挂件
- [bruc3van/agent-buddy-esp32](https://github.com/bruc3van/agent-buddy-esp32) — 4.3 寸 ESP32-S3 屏，显示 Claude Code / Codex / DSH 状态和额度
- [WayAero/esp32s3-buddy](https://github.com/WayAero/esp32s3-buddy) — ESP32-S3 桌面 AI 伙伴，支持触摸审批、状态、角色动画和蓝牙校时
- [Rrttttttt/dsh-beacon](https://github.com/Rrttttttt/dsh-beacon) — DSH 状态灯：DSH 插件 + ESP32-C3 固件
- [haosuo/vibewatch](https://github.com/haosuo/vibewatch) — M5Stack 手表形态，支持 AI 编程会话状态和按住说话语音输入
## License

MIT

