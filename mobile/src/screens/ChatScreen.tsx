import { useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ChatMessage, PeerInfo, RelayStatus } from '../bridge/types';
import type { FileInviteState } from '../bridge/useRoom';
import { MessageBubble } from '../components/MessageBubble';
import { avatarColor, avatarText, colors, font, sizes, spacing } from '../theme/tokens';

export function ChatScreen({
  room,
  nickname,
  myId,
  messages,
  peers,
  relay,
  joined,
  files,
  onSend,
  onLeave,
  onAcceptFile,
  onRejectFile,
}: {
  room: string;
  nickname: string;
  /** 本机 EndpointId —— 判定"是不是我发的"要用它，**不能用昵称比对**
   *  （两个人可能同名；而且改昵称后旧消息的 nickname 还是旧的） */
  myId: string;
  messages: ChatMessage[];
  peers: PeerInfo[];
  relay: RelayStatus;
  joined: boolean;
  /** 文件邀约状态：file_id → 状态 */
  files: Record<string, FileInviteState>;
  onSend: (text: string) => void;
  onLeave: () => void;
  onAcceptFile: (fileId: string) => void;
  onRejectFile: (fileId: string, reason: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const canSend = draft.trim().length > 0 && joined;

  const doSend = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onLeave}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="退出房间"
        >
          <Text style={styles.backText}>退出</Text>
        </TouchableOpacity>

        <View style={styles.headerMid}>
          <Text style={styles.title} numberOfLines={1}>
            {room}
          </Text>
          <View style={styles.subRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: relay.connected ? colors.emerald : colors.textFaint },
              ]}
            />
            <Text style={styles.subtitle} numberOfLines={1}>
              {peers.length} 人 · 我：{nickname}
            </Text>
          </View>
        </View>

        {/* 成员头像堆叠 —— 超过 4 个显示 +N */}
        <View style={styles.stack}>
          {peers.slice(0, 4).map((p, i) => (
            <View
              key={p.id}
              style={[
                styles.stackAvatar,
                { backgroundColor: avatarColor(p.id), marginLeft: i === 0 ? 0 : -10 },
              ]}
            >
              <Text style={styles.stackText}>{avatarText(p.nickname)}</Text>
            </View>
          ))}
          {peers.length > 4 ? (
            <View style={[styles.stackAvatar, styles.stackMore, { marginLeft: -10 }]}>
              <Text style={styles.stackMoreText}>+{peers.length - 4}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          style={styles.flex}
          contentContainerStyle={styles.listContent}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              mine={item.from === myId}
              fileState={item.file ? files[item.file.file_id] : undefined}
              // ⚠️ 只传 fileId：完整 meta 由 useRoom 从邀约缓存里取。
              //    消息里的 `item.file` 是 `FileRef`（少 4 个字段），
              //    传它下去会让 Rust 反序列化失败 —— 见 RoomActions.acceptFile。
              onAcceptFile={onAcceptFile}
              onRejectFile={(id) => onRejectFile(id, '用户取消')}
            />
          )}
          // 新消息进来时贴底。⚠️ Web 端这里踩过坑：
          // 简单滚到底会被"滚动锚定"和"内容还没量完"打败，
          // 移动端先保持简单，等真机上看效果再补。
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {joined ? '还没有消息，说点什么吧' : '正在进入房间…'}
              </Text>
            </View>
          }
        />

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={joined ? '说点什么…' : '连接中…'}
            placeholderTextColor={colors.textFaint}
            multiline
            maxLength={4000}
            editable={joined}
          />
          <TouchableOpacity
            style={[styles.send, !canSend && styles.sendDisabled]}
            disabled={!canSend}
            onPress={doSend}
            accessibilityRole="button"
            accessibilityLabel="发送"
          >
            <Text style={styles.sendText}>发送</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  header: {
    height: sizes.headerH,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.seafoam,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dfe6e8',
  },
  back: { paddingRight: spacing.md, height: '100%', justifyContent: 'center' },
  backText: { fontSize: font.sm, color: colors.cyanDeep },
  headerMid: { flex: 1, justifyContent: 'center' },
  title: { fontSize: font.title, fontWeight: '500', color: colors.navy },
  subRow: { flexDirection: 'row', alignItems: 'center', marginTop: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: spacing.xs },
  subtitle: { fontSize: font.xs, color: colors.textMuted },
  stack: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.sm },
  stackAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.seafoam,
  },
  stackText: { color: '#fff', fontSize: 11, fontWeight: '500' },
  stackMore: { backgroundColor: colors.textFaint },
  stackMoreText: { color: '#fff', fontSize: 10 },
  listContent: { paddingTop: spacing.lg, paddingBottom: spacing.md },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: font.sm, color: colors.textFaint },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.seafoam,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#dfe6e8',
  },
  input: {
    flex: 1,
    minHeight: sizes.composerMinH,
    maxHeight: 120,
    borderRadius: sizes.radiusCard,
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dfe6e8',
    paddingHorizontal: spacing.md,
    paddingTop: 13,
    paddingBottom: 13,
    fontSize: font.body,
    color: colors.text,
  },
  send: {
    marginLeft: spacing.sm,
    height: sizes.composerMinH,
    paddingHorizontal: spacing.lg,
    borderRadius: sizes.radiusCard,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { fontSize: font.body, fontWeight: '500', color: colors.onGold },
});
