/**
 * 设置页。
 *
 * 对应浏览器端的 `frontend/js/ui/sidebar/settings.js`，但**只保留移动端
 * 真正有意义的部分** —— 那边的"主题壁纸"在手机上没有对应物（手机没有
 * 那个三栏布局），照搬只会做一个用不上的开关。
 *
 * 三组：身份（昵称）/ 反馈（震动）/ 关于。
 *
 * ⚠️ 昵称改动**要立刻生效**（调 `setNickname`），不是"注册时才用"——
 *    房间里别人看到的名字要跟着变，否则改了跟没改一样。
 */

import { useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getSettings, subscribeSettings, updateSettings, type Settings } from '../settings';
import { colors, font, sizes, spacing } from '../theme/tokens';

export function SettingsScreen({
  nickname,
  endpointId,
  joined,
  onChangeNickname,
  onBack,
}: {
  nickname: string;
  endpointId: string;
  /** 没进房就不能改昵称（改了也没人看得到，而且 Rust 会拒绝） */
  joined: boolean;
  onChangeNickname: (name: string) => void;
  onBack: () => void;
}) {
  const [s, setS] = useState<Settings>(getSettings);
  // 草稿：改的时候不立刻提交（每次按键都改名会让房间里的人看到名字乱跳）
  const [nickDraft, setNickDraft] = useState(nickname);

  useEffect(() => subscribeSettings(setS), []);
  // 外部（比如换房）改了昵称 → 草稿跟上
  useEffect(() => setNickDraft(nickname), [nickname]);

  const nickTrimmed = nickDraft.trim();
  const nickChanged = nickTrimmed.length > 0 && nickTrimmed !== nickname;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="返回"
        >
          <Text style={styles.backText}>返回</Text>
        </TouchableOpacity>
        <Text style={styles.title}>设置</Text>
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* ---- 身份 ---- */}
        <Text style={styles.sectionTitle}>身份</Text>
        <View style={styles.card}>
          <Text style={styles.label}>昵称</Text>
          <View style={styles.nickRow}>
            <TextInput
              style={styles.input}
              value={nickDraft}
              onChangeText={setNickDraft}
              placeholder="不填就是「匿名」"
              placeholderTextColor={colors.textFaint}
              maxLength={32}
              editable={joined}
            />
            <TouchableOpacity
              style={[styles.saveBtn, (!nickChanged || !joined) && styles.saveBtnOff]}
              disabled={!nickChanged || !joined}
              onPress={() => onChangeNickname(nickTrimmed)}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>保存</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            {joined
              ? '改完点保存，房间里的人会立刻看到新名字。'
              : '进房之后才能改昵称。'}
          </Text>
        </View>

        {/* ---- 反馈 ---- */}
        <Text style={styles.sectionTitle}>反馈</Text>
        <View style={styles.card}>
          <Toggle
            label="收到消息时震动"
            desc="别人的消息到达时轻震一下"
            value={s.hapticsOnMessage}
            onChange={(v) => updateSettings({ hapticsOnMessage: v })}
          />
          <Toggle
            label="文件到达时震动"
            desc="收到文件邀约或传完时，节奏不同"
            value={s.hapticsOnFile}
            onChange={(v) => updateSettings({ hapticsOnFile: v })}
          />
          <Toggle
            label="进房结果震动"
            desc="进房成功或失败时"
            value={s.hapticsOnJoin}
            onChange={(v) => updateSettings({ hapticsOnJoin: v })}
            last
          />
        </View>
        <Text style={styles.hint}>
          手机的「震动」总开关和勿扰模式会覆盖这里 —— 那是系统说了算，
          应用读不到，也没法绕过。
        </Text>

        {/* ---- 关于 ---- */}
        <Text style={styles.sectionTitle}>关于</Text>
        <View style={styles.card}>
          <View style={styles.kv}>
            <Text style={styles.kvLabel}>客户端</Text>
            <Text style={styles.kvValue}>iroh 聊天室 · 移动端</Text>
          </View>
          <View style={styles.kvCol}>
            <Text style={styles.kvLabel}>EndpointId</Text>
            <Text style={styles.mono} selectable>
              {endpointId || '（还没建好）'}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Toggle({
  label,
  desc,
  value,
  onChange,
  last,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
}) {
  return (
    <View style={[styles.toggleRow, last && styles.toggleRowLast]}>
      <View style={styles.toggleMid}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleDesc}>{desc}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: '#d6dde0', true: colors.cyan }}
        thumbColor="#fff"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  header: {
    height: sizes.headerH,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.seafoam,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d6e3e1',
  },
  back: { width: 56 },
  backText: { fontSize: font.body, color: colors.cyanDeep },
  title: { flex: 1, textAlign: 'center', fontSize: font.title, color: colors.navy },
  body: { padding: spacing.lg, paddingBottom: spacing.xl },

  card: {
    backgroundColor: '#fff',
    borderRadius: sizes.radiusCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e3e8ea',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sectionTitle: {
    fontSize: font.sm,
    color: colors.textMuted,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },

  label: { fontSize: font.sm, color: colors.textMuted, marginTop: spacing.sm },
  nickRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  input: {
    flex: 1,
    height: 44,
    borderRadius: sizes.radiusCard,
    backgroundColor: colors.seafoam,
    paddingHorizontal: spacing.md,
    fontSize: font.body,
    color: colors.text,
  },
  saveBtn: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.lg,
    height: 44,
    borderRadius: sizes.radiusCard,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnOff: { opacity: 0.4 },
  saveText: { fontSize: font.sm, fontWeight: '500', color: colors.onGold },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eef2f3',
  },
  toggleRowLast: { borderBottomWidth: 0 },
  toggleMid: { flex: 1, paddingRight: spacing.md },
  toggleLabel: { fontSize: font.body, color: colors.text },
  toggleDesc: { fontSize: font.xs, color: colors.textFaint, marginTop: 2, lineHeight: 16 },

  hint: {
    fontSize: font.xs,
    color: colors.textFaint,
    marginTop: spacing.sm,
    lineHeight: 17,
  },

  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  kvCol: { paddingVertical: spacing.sm },
  kvLabel: { fontSize: font.sm, color: colors.textMuted },
  kvValue: { fontSize: font.sm, color: colors.text },
  mono: { fontSize: font.xs, color: colors.text, marginTop: spacing.xs, lineHeight: 16 },
});
