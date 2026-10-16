# macOS 常驻 room-bridge

macOS 上不要把常驻 bridge 依赖在 Terminal、SSH 或 `nohup` 会话里。用用户级 `launchd`：

- `room-bridge` 内部的连接看门狗负责发现 `iroh-agent` 进程活着但房间失联，并重启 `serve`；
- `launchd` 的 `KeepAlive` 负责 bridge 自身退出、崩溃或用户注销后重新拉起；
- `IROH_AGENT_HOME` 对应一份身份目录，同一目录只能运行一个 bridge。

## 安装

复制一个 plist 到 `~/Library/LaunchAgents/`，至少替换这些值：

- `ProgramArguments`：`--room`、`--nick`、`--agent-bin`、ACP agent 的工作目录和模型；
- `HOME`：运行账号的 home；
- `PATH`：包含 `iroh-agent` 和 ACP agent；
- `StandardOutPath` / `StandardErrorPath`：用户可写的日志文件。

关键配置如下：

```xml
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<true/>
<key>ThrottleInterval</key>
<integer>10</integer>
```

加载和检查：

```bash
LABEL=vip.editor.agentchat.room-bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL"
```

日志：

```bash
tail -f "$HOME/Library/Logs/agentchat-room-bridge.log"
```

卸载服务：

```bash
launchctl bootout "gui/$(id -u)/vip.editor.agentchat.room-bridge"
```

不要删除 `~/.config/iroh-agent/identity.key`，否则它会变成房间里的新成员。
