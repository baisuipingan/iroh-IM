import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RelayStatus } from '../bridge/types';
import type { JoinParams } from '../bridge/useRoom';
import { colors, font, sizes, spacing } from '../theme/tokens';

export type { JoinParams };

export function JoinScreen({
  onJoin,
  relay,
  connecting,
  error,
  note,
}: {
  onJoin: (p: JoinParams) => void;
  relay: RelayStatus;
  connecting: boolean;
  error: string | null;
  /**
   * 非致命说明（当前只有一条：中继配置用了内置兜底）。
   * ⚠️ 与 `error` 分开：兜底**能连上**，不是错误；但排查"连不上"时它是第一个要看的信息。
   */
  note?: string;
}) {
  const [room, setRoom] = useState('');
  const [nick, setNick] = useState('');
  const canSubmit = room.trim().length > 0 && !connecting;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <Text style={styles.brand}>iroh 聊天室</Text>
          <Text style={styles.tagline}>端到端加密 · 移动客户端</Text>

          <View style={styles.relayRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: relay.connected ? colors.emerald : colors.textFaint },
              ]}
            />
            <Text style={styles.relayText}>
              {relay.connected
                ? `已连中继${relay.rtt_ms != null ? ` · ${relay.rtt_ms}ms` : ''}`
                : connecting
                  ? '正在连接中继…'
                  : '未连接'}
            </Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>房间名</Text>
            <TextInput
              style={styles.input}
              value={room}
              onChangeText={setRoom}
              placeholder="例如：比奇堡"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
            <Text style={styles.hint}>房间名就是访问凭据，知道名字的人都能进来</Text>

            <Text style={[styles.label, styles.label2]}>你的昵称</Text>
            <TextInput
              style={styles.input}
              value={nick}
              onChangeText={setNick}
              placeholder="不填就是「匿名」"
              placeholderTextColor={colors.textFaint}
              returnKeyType="go"
              onSubmitEditing={() => {
                if (canSubmit) onJoin({ room: room.trim(), nickname: nick.trim() || '匿名' });
              }}
            />
          </View>

          {note ? <Text style={styles.note}>{note}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.btn, !canSubmit && styles.btnDisabled]}
            disabled={!canSubmit}
            onPress={() => onJoin({ room: room.trim(), nickname: nick.trim() || '匿名' })}
            accessibilityRole="button"
          >
            {connecting ? (
              <ActivityIndicator color={colors.onGold} />
            ) : (
              <Text style={styles.btnText}>进入房间</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  body: { flex: 1, paddingHorizontal: spacing.xl, justifyContent: 'center' },
  brand: { fontSize: 28, fontWeight: '500', color: colors.navy },
  tagline: { fontSize: font.sm, color: colors.textMuted, marginTop: spacing.xs },
  relayRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  relayText: { fontSize: font.sm, color: colors.textMuted },
  form: { marginTop: spacing.xl },
  label: { fontSize: font.sm, color: colors.textMuted, marginBottom: spacing.sm },
  label2: { marginTop: spacing.lg },
  input: {
    height: 48,
    borderRadius: sizes.radiusCard,
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dfe6e8',
    paddingHorizontal: spacing.md,
    fontSize: font.body,
    color: colors.text,
  },
  hint: { fontSize: font.xs, color: colors.textFaint, marginTop: spacing.xs },
  error: { fontSize: font.sm, color: colors.coral, marginTop: spacing.lg },
  // 兜底说明用中性色：它是"提示"，不是"故障"
  note: { fontSize: font.xs, color: colors.textMuted, marginTop: spacing.lg },
  btn: {
    height: 52,
    borderRadius: sizes.radiusCard,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  btnDisabled: { opacity: 0.45 },
  btnText: { fontSize: font.body, fontWeight: '500', color: colors.onGold },
});
