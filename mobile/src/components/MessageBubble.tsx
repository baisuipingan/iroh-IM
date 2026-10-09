import { StyleSheet, Text, View } from 'react-native';
import type { ChatMessage } from '../bridge/types';
import type { FileInviteState, OutFileState } from '../bridge/useRoom';
import { avatarColor, avatarText, colors, font, sizes, spacing } from '../theme/tokens';
import { FileCard } from './FileCard';

/** 相对时间：今天显示 HH:MM，昨天显示"昨天 HH:MM"，更早显示 M/D */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const isYesterday =
    d.getFullYear() === y.getFullYear() &&
    d.getMonth() === y.getMonth() &&
    d.getDate() === y.getDate();
  if (isYesterday) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function MessageBubble({
  message,
  mine,
  fileState,
  outState,
  onAcceptFile,
  onRejectFile,
}: {
  message: ChatMessage;
  mine: boolean;
  /** 该文件的邀约状态（只有收到的文件才有；历史消息没有） */
  fileState?: FileInviteState;
  /** **我发出的**文件状态 */
  outState?: OutFileState;
  onAcceptFile?: (fileId: string) => void;
  onRejectFile?: (fileId: string) => void;
}) {
  // 带 file 的消息渲染成卡片，不是气泡 —— 否则会出现一条空气泡（文案很丑）
  if (message.file) {
    return (
      <FileCard
        message={message}
        mine={mine}
        state={fileState}
        outState={outState}
        onAccept={onAcceptFile}
        onReject={onRejectFile}
      />
    );
  }

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
      {!mine ? (
        <View style={[styles.avatar, { backgroundColor: avatarColor(message.from) }]}>
          <Text style={styles.avatarText}>{avatarText(message.nickname)}</Text>
        </View>
      ) : null}

      <View style={styles.col}>
        {!mine ? <Text style={styles.nick}>{message.nickname}</Text> : null}
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
          <Text style={[styles.text, mine ? styles.textMine : styles.textOther]}>
            {message.text}
          </Text>
        </View>
        <Text style={[styles.time, mine ? styles.timeMine : styles.timeOther]}>
          {fmtTime(message.ts)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    // 长文本要靠这个约束才能正确换行（不设的话会溢出撑宽）
    maxWidth: '100%',
  },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
    marginTop: 18,
  },
  avatarText: { color: '#fff', fontSize: font.sm, fontWeight: '500' },
  col: { flexShrink: 1, maxWidth: '78%' },
  nick: {
    fontSize: font.xs,
    color: colors.textFaint,
    marginBottom: 3,
    marginLeft: spacing.xs,
  },
  bubble: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 1,
    borderRadius: sizes.radiusBubble,
  },
  bubbleMine: { backgroundColor: colors.bubbleMine, borderBottomRightRadius: 6 },
  bubbleOther: {
    backgroundColor: colors.bubbleOther,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e2e8ea',
  },
  text: { fontSize: font.body, lineHeight: 22 },
  textMine: { color: colors.onGold },
  textOther: { color: colors.text },
  time: { fontSize: font.xs, color: colors.textFaint, marginTop: 3 },
  timeMine: { textAlign: 'right', marginRight: spacing.xs },
  timeOther: { marginLeft: spacing.xs },
});
