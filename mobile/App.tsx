/* ============================================================================
 * App —— 两屏切换：进房 → 聊天
 *
 * 这里刻意**不引导航库**：v1 只有两个屏，用状态切换就够，
 * 省掉一个依赖（导航库是 RN 里最容易引入版本冲突的东西之一）。
 * 等屏数超过 4 个再上 @react-navigation。
 *
 * ⚠️ 房间与昵称的**权威状态在 useRoom 里**，这里不再自己存一份 ——
 *    两份状态一定会不同步（踩过：顶部显示昵称、气泡判定用另一份）。
 * ==========================================================================*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Transport } from './src/bridge/transport';
import { MockTransport } from './src/bridge/mock';
import { useRoom, type JoinParams } from './src/bridge/useRoom';
import { ChatScreen } from './src/screens/ChatScreen';
import { JoinScreen } from './src/screens/JoinScreen';
import { colors } from './src/theme/tokens';

/** 默认中继配置（与 Web 端 relay-config.json 同一台） */
const DEFAULT_RELAYS = ['https://iroh1.editor.vip:15443'];

export default function App() {
  const [transport, setTransport] = useState<Transport | null>(null);
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

  const st = useRoom(transport);

  const handleJoin = useCallback(
    async (p: JoinParams) => {
      if (busy.current) return;
      busy.current = true;
      try {
        setConnecting(true);
        setBootError(null);
        await st.join(p);
      } finally {
        setConnecting(false);
        busy.current = false;
      }
    },
    [st],
  );

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="dark" />
        {st.room ? (
          <ChatScreen
            room={st.room}
            nickname={st.nickname}
            myId={transport?.endpointId ?? ''}
            messages={st.messages}
            peers={st.peers}
            relay={st.relay}
            joined={st.joined}
            onSend={st.send}
            onLeave={st.leave}
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
