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
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Transport } from './src/bridge/transport';
import { MockTransport } from './src/bridge/mock';
import { NativeTransport } from './src/bridge/native';
import { useRoom, type JoinParams } from './src/bridge/useRoom';
import { ChatScreen } from './src/screens/ChatScreen';
import { JoinScreen } from './src/screens/JoinScreen';
import { colors, font, spacing } from './src/theme/tokens';
import { nativeStatus } from './modules/iroh-native/src';

/* ---------------------------------------------------------------------------
 * 中继配置 —— 与 `frontend/relay-config.json` 保持一致。
 *
 * ⚠️ 这里是**手抄的副本**。改线上中继配置时这里要一起改，否则移动端会连到
 *    已经下线/改名的那台。正式做法是把这份 JSON 也打进 App（或进 EAS secret），
 *    但 v1 先手工同步 —— 只有三台、且很少动。
 * -------------------------------------------------------------------------*/

const RELAY_URLS = [
  'https://iroh1.editor.vip:15443',
  'https://iroh2.editor.vip:15443',
  'https://iroh3.editor.vip:15443',
];
const RELAY_TOKEN = '44d51ffb6ddab961c6c8cdfe802e0752e0dee3b5cb486916';
/** 常驻节点（提供历史 + 在线状态） */
const ANCHOR_ID = '5bcc4ea3bb56f17041390a9f171bb03a16f107f95ecb93097f80a985845aaab6';
const ANCHOR_RELAY = 'https://iroh1.editor.vip:15443';

export default function App() {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  /** 当前用的是原生模块还是假数据 —— 必须可见（见下方提示条） */
  const [usingNative, setUsingNative] = useState(false);
  const busy = useRef(false);

  // 启动即创建节点（并开始连中继），这样进房页就能显示中继状态
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setConnecting(true);

        // ★ 优先用原生模块；不可用（iOS / Expo Go / .so 没编出来）时回退 mock。
        //
        //   ⚠️ 回退**必须可见** —— 界面上要能看出在用假的，
        //      否则"以为在测真链路、其实在看假数据"会成为常态。
        //      见下方 uiStatus 与"用 mock 数据"提示条。
        const status = nativeStatus();
        if (status.available) {
          try {
            const t = await NativeTransport.create({
              relays: RELAY_URLS,
              relayToken: RELAY_TOKEN,
              anchorId: ANCHOR_ID,
              anchorRelay: ANCHOR_RELAY,
            });
            await t.online();
            if (!alive) {
              await t.shutdown();
              return;
            }
            setTransport(t);
            setUsingNative(true);
            return;
          } catch (e) {
            // 原生可用但启动失败：记下来，继续回退 mock（别让 App 白屏）
            setBootError(`原生节点启动失败，已回退假数据：${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (status.reason) {
          setBootError(`原生模块不可用，当前是假数据：${status.reason}`);
        }

        const t = new MockTransport();
        await t.online();
        if (!alive) return;
        setTransport(t);
        setUsingNative(false);
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
        {/* ★ 假数据提示条：**必须可见**。
            否则"以为在测真链路、其实在看假数据"会成为常态 ——
            这个项目在 Web 端已经踩过一次（mock 时序不对导致掩盖真 bug）。 */}
        {transport && !usingNative ? (
          <View style={styles.mockBar}>
            <Text style={styles.mockBarText}>
              假数据模式（未接原生模块）
            </Text>
          </View>
        ) : null}
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
  // 假数据提示条：刻意显眼（珊瑚色），但只占一行不挡内容
  mockBar: {
    backgroundColor: colors.coral,
    paddingVertical: spacing.xs + 1,
    paddingHorizontal: spacing.md,
  },
  mockBarText: {
    color: '#fff',
    fontSize: font.xs,
    textAlign: 'center',
  },
});
