/* ============================================================================
 * App —— 两屏切换：进房 → 聊天
 *
 * 这里刻意**不引导航库**：v1 只有两个屏，用 useState 切换就够，
 * 省掉一个依赖（导航库是 RN 里最容易引入版本冲突的东西之一）。
 * 等屏数超过 4 个再上 @react-navigation。
 * ==========================================================================*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Transport } from './src/bridge/transport';
import { MockTransport } from './src/bridge/mock';
import { useRoom } from './src/bridge/useRoom';
import { ChatScreen } from './src/screens/ChatScreen';
import { JoinScreen, type JoinParams } from './src/screens/JoinScreen';
import { colors } from './src/theme/tokens';

/** 默认中继配置（与 Web 端 relay-config.json 同一台） */
const DEFAULT_RELAYS = ['https://iroh1.editor.vip:15443'];

export default function App() {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [nickname, setNickname] = useState('匿名');
  const [connecting, setConnecting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const busy = useRef(false);

  // 启动即创建节点（并开始连中继），这样进房页就能显示中继状态
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setConnecting(true);
        // ⚠️ 换成真模块时只改这一行：
        //   const t = await NativeTransport.create({ relays: DEFAULT_RELAYS })
        const t = new MockTransport();
        await t.online();
        if (!alive) return;
        setTransport(t);
      } catch (e) {
        if (alive) setBootError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setConnecting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const st = useRoom(transport, room);

  const handleJoin = useCallback(
    async (p: JoinParams) => {
      if (!transport || busy.current) return;
      busy.current = true;
      try {
        setConnecting(true);
        setBootError(null);
        await transport.join({ room: p.room, nickname: p.nickname, relays: DEFAULT_RELAYS });
        setNickname(p.nickname);
        setRoom(p.room);
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      } finally {
        setConnecting(false);
        busy.current = false;
      }
    },
    [transport],
  );

  const handleLeave = useCallback(async () => {
    setRoom(null);
    await transport?.leaveRoom().catch(() => undefined);
  }, [transport]);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="dark" />
        {room ? (
          <ChatScreen
            room={room}
            nickname={nickname}
            messages={st.messages}
            peers={st.peers}
            relay={st.relay}
            joined={st.joined}
            onSend={st.send}
            onLeave={handleLeave}
          />
        ) : (
          <JoinScreen
            onJoin={handleJoin}
            relay={st.relay}
            connecting={connecting}
            error={bootError ?? st.error}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
});
