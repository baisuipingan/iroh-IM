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
import { Linking, StyleSheet, Text, View } from 'react-native';
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
 * 深链解析：irohchat://join?room=xxx&nick=yyy
 *
 * 只给真机回归用（配合下面的自动进房钩子）。**没有** `room` 就返回 null ——
 * 别让一个手滑的链接把 App 带进空房间。
 * -------------------------------------------------------------------------*/
function parseAutoJoinUrl(url: string): JoinParams | null {
  try {
    // irohchat://join?room=… —— RN 的 URL 解析对自定义 scheme 支持一般，
    // 这里手工切更可靠（host 是 "join"，query 在后面）
    const q = url.indexOf('?');
    if (!url.startsWith('irohchat://join') || q < 0) return null;
    const params = new URLSearchParams(url.slice(q + 1));
    const room = (params.get('room') ?? '').trim();
    if (!room) return null;
    return { room, nickname: (params.get('nick') ?? '').trim() || '匿名' };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * 深链解析：irohchat://send?text=xxx
 *
 * 同样只给真机回归用（配合下面的自动发消息钩子）。
 * `text` 必须是**显式且非空**，避免空消息被当成"要发送"。
 * -------------------------------------------------------------------------*/
function parseAutoSendUrl(url: string): string | null {
  try {
    const q = url.indexOf('?');
    if (!url.startsWith('irohchat://send') || q < 0) return null;
    const params = new URLSearchParams(url.slice(q + 1));
    const text = (params.get('text') ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}

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

  /* ==========================================================================
   * ★ 自动进房（真机回归用）
   *
   * 为什么需要它：真机上用 `adb shell input text` 往 React Native 的
   * 受控 TextInput 里打字**不可靠** —— 合成按键常常进不去，
   * 输入法的候选浮层还会混进来。实测折腾了十几轮都没稳定输入成功，
   * 每次真机验证都得手动戳屏幕，既慢又容易点错。
   *
   * 用法（拉起 App 的同时进房）：
   *
   *     adb shell am start -a android.intent.action.VIEW \
   *       -d "irohchat://join?room=smoketest1&nick=tester"
   *
   * ⚠️ 为什么**不用** `__DEV__` 把关：release 包里 `__DEV__` 是 false，
   *    而这个钩子的用处恰恰是"对 release 包做真机回归"。
   *    门槛改由 **URL 本身**承担 —— 必须显式带 `irohchat://join?room=`，
   *    普通用户不可能手滑构造出它；且自动进房本身没有任何破坏性。
   * =====================================================================*/
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!transport || autoJoined.current) return;

    const tryAutoJoin = (url: string | null): void => {
      if (!url || autoJoined.current) return;
      const target = parseAutoJoinUrl(url);
      if (!target) return;
      autoJoined.current = true;
      // 打一条日志：真机回归时靠它确认钩子确实触发了
      //（`adb logcat -s ReactNativeJS | grep autojoin`）
      console.log(`[autojoin] 命中深链，自动进房 room=${target.room}`);
      void handleJoin(target);
    };

    // 运行中收到链接（onNewIntent）
    const sub = Linking.addEventListener('url', ({ url }) => tryAutoJoin(url));
    // 冷启动时带链接（getInitialURL）
    void Linking.getInitialURL().then(tryAutoJoin);

    return () => sub.remove();
  }, [transport, handleJoin]);

  /* ==========================================================================
   * ★ 自动发消息（真机回归用）—— 和上面的自动进房配套
   *
   * 用法（进房之后再发一条）：
   *
   *     adb shell am start -a android.intent.action.VIEW \
   *       -d "irohchat://send?text=hello&room=batch1"
   *
   * 为什么需要它：`adb shell input text` 打不进 RN 的受控 TextInput
   * （合成按键进不了 JS 事件流，实测十几轮都不行），剪贴板写入在
   * MIUI 上也没走通。与其和输入法较劲，不如留一个可控的入口 ——
   * 顺带让整条真机回归可以完全脚本化。
   *
   * 门槛同样由 URL 承担（必须显式 `irohchat://send?text=`）。
   * =====================================================================*/
  const sendRef = useRef(st.send);
  sendRef.current = st.send; // 始终指向最新的 send，不把 st 塞进依赖

  useEffect(() => {
    if (!transport || !st.joined) return; // 没进房不发

    const tryAutoSend = (url: string | null): void => {
      if (!url) return;
      const text = parseAutoSendUrl(url);
      if (!text) return;
      // 打日志带上 joined 状态：真机回归时靠它区分
      //"钩子没触发" 与 "触发了但被 joined 挡下"
      console.log(`[autosend] 命中深链，发送消息 len=${text.length}`);
      void sendRef.current(text);
    };

    // ⚠️ 依赖里**只放 joined**，不放整个 `st`。
    //    `st` 每次消息/成员变化都是新对象 → effect 会反复重订阅；
    //    更糟的是冷启动时 getInitialURL 的 promise 可能落在两次订阅之间，
    //    消息就静默丢了（真踩过：钩子日志打了，但消息没发出去）。
    const sub = Linking.addEventListener('url', ({ url }) => tryAutoSend(url));
    void Linking.getInitialURL().then(tryAutoSend);
    return () => sub.remove();
  }, [transport, st.joined]);

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
            files={st.files}
            onSend={st.send}
            onLeave={st.leave}
            onAcceptFile={st.acceptFile}
            onRejectFile={st.rejectFile}
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
