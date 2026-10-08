import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ChatMessage } from '../bridge/types';
import { colors, font, sizes, spacing } from '../theme/tokens';

/** 人类可读的文件大小 —— 1024 进制，保留 1 位小数 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * 文件卡片。
 *
 * ⚠️ 这里只做**展示**：v1 先不支持接收（Rust 侧 `accept_file` 已实现，
 *    但 RN 侧的文件落盘要走平台 API，等原生产物接上再补）。
 *    所以卡片上的按钮是 disabled 的，**并且用文字说明原因** ——
 *    比一个点了没反应的按钮诚实。
 */
export function FileCard({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const f = message.file;
  if (!f) return null;

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
      <View style={styles.card}>
        <View style={styles.iconBox}>
          <Text style={styles.iconText}>{f.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE'}</Text>
        </View>

        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={2}>
            {f.name}
          </Text>
          <Text style={styles.meta}>
            {fmtSize(f.size)} · {mine ? '我发出的' : '对方发出'}
          </Text>
        </View>

        <TouchableOpacity style={styles.btn} disabled accessibilityLabel="接收文件（暂未开放）">
          <Text style={styles.btnText}>接收</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.hint}>文件接收将在原生模块接入后开放</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: spacing.md, paddingHorizontal: spacing.lg },
  rowMine: { alignItems: 'flex-end' },
  rowOther: { alignItems: 'flex-start' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bubbleOther,
    borderRadius: sizes.radiusCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e2e8ea',
    padding: spacing.md,
    maxWidth: '92%',
    minWidth: 260,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.seafoam2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  iconText: { fontSize: 10, color: colors.cyanDeep, fontWeight: '500' },
  info: { flex: 1, marginRight: spacing.sm },
  name: { fontSize: font.body, color: colors.text, fontWeight: '500' },
  meta: { fontSize: font.xs, color: colors.textFaint, marginTop: 3 },
  btn: {
    paddingHorizontal: spacing.md,
    height: sizes.touchTarget - 8,
    borderRadius: sizes.radiusCard,
    backgroundColor: colors.seafoam,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.5,
  },
  btnText: { fontSize: font.sm, color: colors.textMuted },
  hint: { fontSize: font.xs, color: colors.textFaint, marginTop: spacing.xs },
});
