import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ChatMessage } from '../bridge/types';
import type { FileInviteState, OutFileState } from '../bridge/useRoom';
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
 * ## 状态与按钮
 *
 * - `invited`：显示「接收」，点了开始收
 * - `receiving`：按钮禁用并显示「接收中…」—— **这个状态必须有**：
 *   接收是阻塞调用，310 MB 可能要几分钟，不给反馈用户会以为卡死
 * - `done`：显示「已保存」+ 落盘位置
 * - `failed`：显示「重试」+ 失败原因
 *
 * `state` 为 `undefined` 表示这条是**历史里的文件消息**、本次会话没收到邀约
 * （比如进房时拉回来的旧记录）—— 这种情况下没东西可收，如实说明。
 */
export function FileCard({
  message,
  mine,
  state,
  outState,
  onAccept,
  onReject,
}: {
  message: ChatMessage;
  mine: boolean;
  /** 本次会话收到的邀约状态（没有 = 历史消息，收不了） */
  state?: FileInviteState;
  /** **我发出的**文件状态（等对方接收 / 发送中 / 完成） */
  outState?: OutFileState;
  onAccept?: (fileId: string) => void;
  onReject?: (fileId: string) => void;
}) {
  const f = message.file;
  if (!f) return null;

  const status = state?.status ?? 'idle';
  // 自己发的文件不需要"接收"
  const actionable = !mine && (status === 'invited' || status === 'failed');
  const receiving = status === 'receiving';

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

        {actionable ? (
          <View style={styles.btnGroup}>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, status === 'failed' && styles.btnRetry]}
              onPress={() => onAccept?.(f.file_id)}
              accessibilityLabel={status === 'failed' ? '重试接收文件' : '接收文件'}
            >
              <Text style={styles.btnTextStrong}>{status === 'failed' ? '重试' : '接收'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.btnGhost}
              onPress={() => onReject?.(f.file_id)}
              accessibilityLabel="拒绝接收文件"
            >
              <Text style={styles.btnGhostText}>拒绝</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.btn, (receiving || status === 'done') && styles.btnDisabled]}
            disabled
            accessibilityLabel={receiving ? '正在接收文件' : '接收文件'}
          >
            <Text style={styles.btnText}>
              {receiving ? '接收中…' : status === 'done' ? '已保存' : '接收'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 我发出的文件：显示发送状态 */}
      {mine && outState ? (
        <Text style={outState.status === 'failed' ? styles.hintErr : styles.hintOk}>
          {outState.detail ??
            (outState.status === 'publishing'
              ? '正在计算校验值…'
              : outState.status === 'offered'
                ? '已发出，等对方接收…'
                : outState.status === 'sending'
                  ? '正在发送…'
                  : outState.status === 'rejected'
                    ? '对方拒绝接收'
                    : '已发送')}
        </Text>
      ) : null}

      {/* 状态说明：收完显示落盘位置；失败显示原因；历史卡片如实说明收不了 */}
      {status === 'done' && state?.detail ? (
        <Text style={styles.hintOk}>{state.detail}</Text>
      ) : null}
      {status === 'failed' && state?.detail ? (
        <Text style={styles.hintErr}>{state.detail}</Text>
      ) : null}
      {status === 'idle' && !mine ? (
        <Text style={styles.hint}>这条是历史记录，发送方已不在线，暂时无法接收</Text>
      ) : null}
      {receiving ? <Text style={styles.hint}>正在接收，请保持在前台…</Text> : null}
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
  btnGroup: { alignItems: 'center', gap: 4 },
  btn: {
    paddingHorizontal: spacing.md,
    height: sizes.touchTarget - 8,
    borderRadius: sizes.radiusCard,
    backgroundColor: colors.seafoam,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: colors.seafoam },
  btnRetry: { backgroundColor: '#fdd835' },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: font.sm, color: colors.textMuted },
  btnTextStrong: { fontSize: font.sm, color: colors.text, fontWeight: '500' },
  btnGhost: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  btnGhostText: { fontSize: font.xs, color: colors.textFaint },
  hint: { fontSize: font.xs, color: colors.textFaint, marginTop: spacing.xs },
  hintOk: { fontSize: font.xs, color: colors.textMuted, marginTop: spacing.xs },
  hintErr: { fontSize: font.xs, color: '#c62828', marginTop: spacing.xs },
});
