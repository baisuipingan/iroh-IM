/**
 * 连接状态页。
 *
 * 对应浏览器端的 `frontend/js/ui/sidebar/status.js`，但**按手机重排**：
 * 浏览器端是侧栏第二页（三栏布局里的一栏），手机没有侧栏 ——
 * 做成一个全屏页，从聊天页顶栏点进来。
 *
 * 展示的是"这套连接现在长什么样"：中继、人数、我的身份、每个成员。
 * 排查问题时最需要的东西：**我的 EndpointId**（对方要靠它找我）、
 * **中继是否连上**、**每个人最后一次出现是什么时候**。
 */

import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { PeerInfo, RelayInfoLike, RelayStatus } from '../bridge/types';
import { avatarColor, avatarText, colors, font, sizes, spacing } from '../theme/tokens';

/**
 * 中继地址 → 可读的区域名。
 *
 * ⚠️ 这是**纯展示用的映射**，不参与任何逻辑判断 ——
 *    所以取不到名字时退回显示域名本身即可，**不要**因为找不到就
 *    把这条中继藏起来（那样会让人以为"没配这台"）。
 *
 *    为什么不在 Rust 侧给区域名：那是 UI 关心的事，
 *    核心库不该带一张"地名表"（它还要编 wasm、给 CLI 用）。
 */
const REGION_BY_HOST: Record<string, string> = {
  'iroh1.editor.vip': '中国香港',
  'iroh2.editor.vip': '欧洲',
  'iroh3.editor.vip': '法国',
};

function regionOf(url: string): string {
  const host = url.replace(/^https?:\/\//, '').split(':')[0] ?? '';
  return REGION_BY_HOST[host] ?? host;
}

export function ConnectionScreen({
  room,
  nickname,
  endpointId,
  relay,
  relayList,
  peers,
  onBack,
}: {
  room: string;
  nickname: string;
  endpointId: string;
  /** 当前在用的那一台（摘要） */
  relay: RelayStatus;
  /** **全部**配置的中继及状态 —— 排查时要看"另外两台怎么了" */
  relayList: RelayInfoLike[];
  peers: PeerInfo[];
  onBack: () => void;
}) {
  /* 中继列表：把**当前正在用的那台**排在最前，其余按配置顺序列出。
   *
   * ⚠️ 不要只显示 `relay.url` 那一台 —— 用户排查问题时会问
   *    "我配了几台、为什么选了这台"，只显示一台答不上来。
   *    没连上的也列出来（灰色），一眼能看出是"没连"还是"没配"。 */
  const relays = useMemo(() => {
    const cur = relay.url;
    // 当前那台排最前（用户最关心的就是"我在用哪台"）
    const ordered = [
      ...relayList.filter((r) => r.url === cur),
      ...relayList.filter((r) => r.url !== cur),
    ];
    return ordered.map((r) => ({
      url: r.url,
      region: regionOf(r.url),
      active: r.url === cur,
      // ⚠️ 用**每台自己的** connected，不是 `relay.connected`（那是当前台的）。
      //    早先写成 `r.url === cur && relay.connected` 导致每台都显示"备用"。
      connected: r.connected,
      error: r.lastError ?? r.authDenied ?? null,
    }));
  }, [relayList, relay.url]);

  const now = Date.now();

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
        <Text style={styles.title}>连接状态</Text>
        {/* 占位，让标题居中（与返回按钮等宽） */}
        <View style={styles.back} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* ---- 概览 ---- */}
        <View style={[styles.card, styles.cardRow]}>
          <Stat label="当前房间" value={room || '—'} />
          <Stat label="在线人数" value={`${peers.length + 1}`} note="含我自己" />
        </View>

        {/* ---- 中继 ---- */}
        <Text style={styles.sectionTitle}>中继节点</Text>
        <View style={styles.card}>
          {relays.map((r) => (
            <View key={r.url} style={styles.relayRow}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: r.connected ? colors.emerald : colors.outline },
                ]}
              />
              <View style={styles.relayMid}>
                <Text style={styles.relayRegion}>
                  {r.region}
                  {r.active ? <Text style={styles.tag}> · 当前</Text> : null}
                </Text>
                <Text style={styles.relayUrl} numberOfLines={1}>
                  {/* 去掉 scheme 与**尾部斜杠**：Rust 的 `RelayUrl` Display
                      会带上尾 `/`（`https://x:15443/`），显示出来很碍眼 */}
                  {r.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </Text>
              </View>
              <Text
                style={[
                  styles.relayState,
                  {
                    color: r.connected
                      ? colors.emeraldText
                      : r.active
                        ? colors.coral
                        : colors.textFaint,
                  },
                ]}
              >
                {/* ⚠️ 三种状态要分清（原来这里只有 connected/备用 两档，
                    当前那台没连上时会显示成"备用"，看不出问题）：
                      · 当前且连上 → 延迟 / 已连接
                      · 当前但没连上 → **未连接**（要显眼，这是异常）
                      · 不是当前那台 → 备用
                    另外 `r.connected` 已经包含了"是不是当前那台"，
                    别再单独判一次 relay.connected（会与 active 打架）。 */}
                {r.connected
                  ? relay.rtt_ms != null
                    ? `${relay.rtt_ms}ms`
                    : '已连接'
                  : r.active
                    ? '未连接'
                    : '备用'}
              </Text>
            </View>
          ))}
        </View>
        <Text style={styles.hint}>
          多台中继由 iroh 按延迟自己挑。两人选到不同台是正常的 ——
          每台都会广播自己的地址，对端直接拨过去。
        </Text>

        {/* ---- 我的身份 ---- */}
        <Text style={styles.sectionTitle}>我的身份</Text>
        <View style={styles.card}>
          <View style={styles.kv}>
            <Text style={styles.kvLabel}>昵称</Text>
            <Text style={styles.kvValue}>{nickname || '—'}</Text>
          </View>
          <View style={styles.kvCol}>
            <Text style={styles.kvLabel}>EndpointId</Text>
            {/* 这是对方用来找我的地址 —— 排查"连不上"时要把它给对方看 */}
            <Text style={styles.mono} selectable>
              {endpointId || '（还没建好）'}
            </Text>
          </View>
        </View>

        {/* ---- 成员 ---- */}
        <Text style={styles.sectionTitle}>在线成员</Text>
        <View style={styles.card}>
          {peers.length === 0 ? (
            <Text style={styles.empty}>
              房间里只有我一个。房间名就是访问凭据，把它告诉对方即可。
            </Text>
          ) : (
            peers.map((p, i) => (
              <View
                key={p.id}
                style={[styles.peerRow, i === peers.length - 1 && styles.peerRowLast]}
              >
                <View style={[styles.avatar, { backgroundColor: avatarColor(p.id) }]}>
                  <Text style={styles.avatarText}>{avatarText(p.nickname)}</Text>
                </View>
                <View style={styles.peerMid}>
                  <Text style={styles.peerName} numberOfLines={1}>
                    {p.nickname || '匿名'}
                  </Text>
                  <Text style={styles.peerId} numberOfLines={1}>
                    {p.id.slice(0, 16)}…
                  </Text>
                </View>
                <Text style={styles.peerSeen}>
                  {/* 对方多久没出声。这个数字**比"在线"更有信息量** ——
                      能看到心跳是不是还在动 */}
                  {lastSeenText(now, p.lastSeenMs)}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** 概览里的一格 */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
      {note ? <Text style={styles.statNote}>{note}</Text> : null}
    </View>
  );
}

/**
 * "多久没见" 的文案。
 *
 * ⚠️ 阈值别乱调：心跳间隔决定了这个数字的正常范围。
 *    显示"刚刚"而不是精确毫秒 —— 用户要的是"他还在不在"，不是计时。
 */
function lastSeenText(now: number, lastSeenMs: number): string {
  if (!lastSeenMs) return '—';
  const d = Math.max(0, now - lastSeenMs);
  if (d < 5000) return '刚刚';
  if (d < 60000) return `${Math.floor(d / 1000)} 秒前`;
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  return `${Math.floor(d / 3600000)} 小时前`;
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
  cardRow: { flexDirection: 'row' },
  stat: { flex: 1, paddingVertical: spacing.sm },
  statLabel: { fontSize: font.xs, color: colors.textFaint },
  statValue: { fontSize: font.large, color: colors.navy, marginTop: 2 },
  statNote: { fontSize: font.xs, color: colors.textFaint, marginTop: 2 },

  sectionTitle: {
    fontSize: font.sm,
    color: colors.textMuted,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },

  relayRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  relayMid: { flex: 1 },
  relayRegion: { fontSize: font.sm, color: colors.text },
  tag: { fontSize: font.xs, color: colors.cyanDeep },
  relayUrl: { fontSize: font.xs, color: colors.textFaint, marginTop: 1 },
  relayState: { fontSize: font.sm },

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
  mono: {
    fontSize: font.xs,
    color: colors.text,
    marginTop: spacing.xs,
    lineHeight: 16,
  },

  empty: { fontSize: font.sm, color: colors.textMuted, paddingVertical: spacing.sm, lineHeight: 20 },
  peerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eef2f3',
  },
  peerRowLast: { borderBottomWidth: 0 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  avatarText: { fontSize: font.sm, color: '#fff', fontWeight: '500' },
  peerMid: { flex: 1 },
  peerName: { fontSize: font.sm, color: colors.text },
  peerId: { fontSize: font.xs, color: colors.textFaint, marginTop: 1 },
  peerSeen: { fontSize: font.xs, color: colors.textMuted },
});
