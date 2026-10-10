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
import type { FileInviteState, OutFileState } from '../bridge/useRoom';
import { pickFile } from '../bridge/pick-file';
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
  isolated,
  protocolMismatch,
  files,
  outFiles,
  onSend,
  onLeave,
  onAcceptFile,
  onRejectFile,
  onPublishFile,
  onOpenStatus,
  onOpenSettings,
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
  /** 暂时联系不上房间里的其他人（常驻节点重启中 / 中继不可达）——见 useRoom.isolated */
  isolated: boolean;
  /** 协议版本不一致（v5 握手）——见 useRoom.protocolMismatch；null = 一致 */
  protocolMismatch: { ours: string; theirs: string } | null;
  /** 收到的文件邀约：file_id → 状态 */
  files: Record<string, FileInviteState>;
  /** **我发出的**文件：file_id → 状态 */
  outFiles: Record<string, OutFileState>;
  onSend: (text: string) => void;
  onLeave: () => void;
  onAcceptFile: (fileId: string) => void;
  onRejectFile: (fileId: string, reason: string) => void;
  onPublishFile: (uri: string, name: string, size: number, mime: string) => void;
  /** 打开连接状态页 */
  onOpenStatus: () => void;
  /** 打开设置页 */
  onOpenSettings: () => void;
}) {
  const [draft, setDraft] = useState('');
  /** 正在打开系统选择器（防连点） */
  const [picking, setPicking] = useState(false);
  /** 选文件本身的错误（与聊天错误分开，显示在 composer 上方） */
  const [pickError, setPickError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const canSend = draft.trim().length > 0 && joined;

  const doSend = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft('');
  };

  /**
   * 选文件 → 发布。
   *
   * ⚠️ 发布是**长耗时**的（原生侧要先流式算 blake3，大文件几十秒）。
   *    所以先同步置状态（`publishFile` 内部会 setOutFiles），
   *    UI 立刻出现「发布中」的卡片 —— 否则用户以为没反应会连点。
   */
  const doPickFile = async () => {
    if (!joined || picking) return;
    setPicking(true);
    try {
      const picked = await pickFile();
      if (!picked) return; // 用户取消
      onPublishFile(picked.uri, picked.name, picked.size, picked.mime);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
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
                { backgroundColor: relay.connected ? colors.emerald : colors.coral },
              ]}
            />
            <Text style={styles.subtitle} numberOfLines={1}>
              {/* ⚠️ 这里的文案要说**哪一种**断法 —— 排查时差别很大：
                  中继断开 = 传输层报的（房间空时唯一能用的信号）；
                  没有"在线"标记则可能是数据面静默（见 useRoom）。

                  另外：**别写成"已连接"**。`relay.connected` 是 iroh
                  认为的状态，物理断网时它可能仍是 true（真机实测），
                  写"已连接"会让人以为网络没问题。所以在线时只说人数，
                  不下"连接正常"的判断。 */}
              {relay.connected ? `${peers.length} 人 · 我：${nickname}` : '连接丢失 · 正在重连…'}
            </Text>
          </View>
        </View>

        {/* 成员头像堆叠 —— 超过 4 个显示 +N。
            ⚠️ 整块是**进入连接状态页的入口**（点人数看详情是通用直觉）。
               不如做成单独的"详情"按钮：那块地方已经被头像占满了，
               再加一个按钮会挤。 */}
        <TouchableOpacity
          style={styles.stack}
          onPress={onOpenStatus}
          accessibilityRole="button"
          accessibilityLabel="查看连接状态"
        >
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
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.gear}
          onPress={onOpenSettings}
          accessibilityRole="button"
          accessibilityLabel="设置"
        >
          <Text style={styles.gearText}>⚙</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* 孤立：进房成功、但暂时看不到别人。
            ⚠️ 刻意用"提示"而不是错误样式：这不是失败，消息会排队等邻居，
               后台重连接上后会自动补拉历史。把它画成红色会让人以为发不出去。 */}
        {isolated ? (
          <View style={styles.isolated}>
            <Text style={styles.isolatedText}>
              暂时联系不上房间里的其他人，正在后台重连。这期间你发的消息会先排队。
            </Text>
          </View>
        ) : null}

        {/* 协议版本不一致：**必须**说出来。
            旧的表现是两端把对方的消息当"验签失败"悄悄丢掉 —— 用户只会看到
            "消息丢了"，没有任何线索。这里明确告诉他该升级/刷新了。
            用错误红：它不会自愈，只能靠升级（与 isolated 那条刻意不同）。 */}
        {protocolMismatch ? (
          <View style={styles.protocolMismatch}>
            <Text style={styles.protocolMismatchText}>
              当前版本（{protocolMismatch.ours}）与房间服务端（
              {protocolMismatch.theirs || '旧版'}）不一致：请升级 App，
              否则双方的消息可能互相收不到。
            </Text>
          </View>
        ) : null}

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
              outState={item.file ? outFiles[item.file.file_id] : undefined}
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

        {/* 选文件本身的错误（不是聊天错误）—— 显示在输入区上方，不挡住消息 */}
        {pickError ? (
          <TouchableOpacity onPress={() => setPickError(null)} style={styles.pickErr}>
            <Text style={styles.pickErrText}>选文件失败：{pickError}（点此关闭）</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.composer}>
          <TouchableOpacity
            style={[styles.attach, !joined && styles.attachDisabled]}
            disabled={!joined}
            onPress={doPickFile}
            accessibilityRole="button"
            accessibilityLabel="发送文件"
          >
            <Text style={styles.attachText}>＋</Text>
          </TouchableOpacity>
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
  gear: {
    width: 36,
    height: sizes.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
  gearText: { fontSize: 20, color: colors.navy2 },
  // 「＋」附件按钮：与输入框同一行，尺寸对齐 touchTarget
  attach: {
    width: sizes.touchTarget,
    height: sizes.composerMinH,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs,
  },
  attachDisabled: { opacity: 0.4 },
  attachText: {
    fontSize: 26,
    lineHeight: 30,
    color: colors.cyanDeep,
    fontWeight: '300',
  },
  pickErr: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: '#fdecea',
  },
  pickErrText: { fontSize: font.xs, color: '#c62828' },
  // 孤立提示条：金色系（"稍安勿躁"），不是错误红
  isolated: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: '#fff8e1',
  },
  isolatedText: { fontSize: font.xs, color: '#8d6e00' },
  // 协议版本不一致：错误红 —— 这条不会自愈（要升级），别当"稍安勿躁"画成金色
  protocolMismatch: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: '#fdecea',
  },
  protocolMismatchText: { fontSize: font.xs, color: '#c62828' },
});
