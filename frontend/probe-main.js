import init, { WebNode } from './pkg/iroh_web.js';
import { loadRelayConfig, probeAll, buildRelayMap, diagnoseRelay } from './probe.js';
import { store } from './js/store.js';
import { esc, withTimeout } from './js/util.js';

const $ = (id) => document.getElementById(id);
let node = null;
let relayCfg = null;
let probeResults = [];

// 把页面/控制台错误也收集起来，便于无头环境排查（wasm 侧日志也走 console）
const consoleLines = [];
for (const method of ['error', 'warn']) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    consoleLines.push(`${method}: ${args.map((a) => (a?.message ?? String(a))).join(' ')}`);
    if (consoleLines.length > 60) consoleLines.shift();
    orig(...args);
  };
}
window.addEventListener('unhandledrejection', (e) => {
  consoleLines.push(`unhandledrejection: ${e.reason?.message ?? e.reason}`);
});

function log(msg, cls = '') {
  const el = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${msg}`;
  if (cls) el.style.color = cls;
  $('log').prepend(el);
}

/** 身份持久化：不做这一步，每次刷新都会换一个 EndpointId。 */
function loadOrCreateSecretKey() {
  return store.identity();
}

function renderProbe(results) {
  probeResults = results;
  $('relay-rows').innerHTML = results
    .map(
      (r) => `<tr>
        <td><span class="mono">${esc(r.url.replace('https://', ''))}</span><br><span class="muted">${esc(r.id || '')}</span></td>
        <td>${r.ok && r.rtt !== null ? Math.round(r.rtt * 10) / 10 + ' ms' : '—'}</td>
        <td>${r.ok ? '<span class="pill ok">可达</span>' : '<span class="pill bad">不可达</span>'}
            ${r.error ? `<br><span class="muted">${esc(r.error)}</span>` : ''}</td>
      </tr>`,
    )
    .join('');
  const alive = results.filter((r) => r.ok);
  const timed = results.filter((r) => r.ok && r.rtt !== null);
  $('probe-state').className = 'pill ' + (alive.length ? 'ok' : 'bad');
  $('probe-state').textContent = alive.length ? `${alive.length}/${results.length} 可用` : '全部不可达';
  $('probe-note').textContent = timed.length
    ? `最快的 ${timed[0].url}（预测 iroh 会选它做 home relay）`
    : alive.length
      ? '中继可达但拿不到细粒度计时（多半是缺 CORS/Timing-Allow-Origin），交给 iroh 自己择优'
      : '检查域名解析 / 配置的中继端口 / 证书；若错误是 Failed to fetch，多看上面的诊断行';
}

function renderStatus(relays) {
  if (!relays.length) {
    $('status-rows').innerHTML = '<tr><td colspan="3" class="muted">等待 iroh 选中 home relay…</td></tr>';
    return;
  }
  $('status-rows').innerHTML = relays
    .map(
      (r) => `<tr>
        <td class="mono">${esc(r.url.replace('https://', ''))}</td>
        <td>${r.connected ? '<span class="pill ok">已连接</span>' : '<span class="pill wait">未连接</span>'}</td>
        <td class="muted">${esc(r.authDenied ? '鉴权被拒：' + r.authDenied : r.lastError ?? '')}</td>
      </tr>`,
    )
    .join('');
}

async function boot() {
  try {
    await init();
    log('wasm 模块加载完成');
  } catch (e) {
    log('wasm 加载失败：' + e, '#96201d');
    return;
  }

  relayCfg = await loadRelayConfig('./relay-config.json').catch((e) => {
    log('中继名单加载失败：' + e, '#96201d');
    return null;
  });
  if (relayCfg) {
    log(`中继名单 v${relayCfg.version}：${relayCfg.relays.map((r) => r.id).join(', ')}`);
    $('peer-relay').value = relayCfg.relays.find((relay) => relay.enabled !== false)?.url || '';
  }
}

$('btn-probe').onclick = async () => {
  if (!relayCfg) return log('中继名单未就绪', '#96201d');
  $('probe-state').className = 'pill wait';
  $('probe-state').textContent = '探测中…';
  const results = await probeAll(relayCfg.relays, { samples: 3, timeoutMs: 2500 });
  renderProbe(results);
  const map = buildRelayMap(results, { k: 3, fallback: relayCfg.relays.filter((relay) => relay.enabled !== false) });
  log(
    `探测完成，交给 iroh 的候选名单：${map.map((m) => m.url).join(', ')}` +
      (results.some((r) => r.ok && r.rtt === null) ? '（拿不到计时，已回退为全量名单）' : ''),
  );
};

$('btn-start').onclick = async () => {
  if (!relayCfg) return log('中继名单未就绪', '#96201d');
  const usableRelays = relayCfg.relays.filter((relay) => relay.enabled !== false);
  if (!usableRelays.length) return log('所有中继都已禁用，至少启用一台后重试', '#96201d');
  $('btn-start').disabled = true;
  $('node-state').className = 'pill wait';
  $('node-state').textContent = '启动中…';

  // 用探测结果排前 K 台；没探测过就全给（让 iroh 自己选）
  const candidates = probeResults.length
    ? buildRelayMap(probeResults, { k: 3, fallback: usableRelays })
    : usableRelays;

  try {
    node = await WebNode.start(
      JSON.stringify({ relays: candidates.map((c) => c.url), relay_token: relayCfg.relay_token ?? null, secret_key_hex: loadOrCreateSecretKey() }),
    );
    $('my-id').textContent = node.endpoint_id();
    $('my-id').title = node.endpoint_id();
    log('节点已绑定，等待中继握手…');

    // 事件流：中继状态 + 对端连入 + 收到的消息
    const stream = node.events();
    (async () => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handleEvent(value);
      }
    })().catch((error) => log('节点事件读取失败：' + (error?.message ?? error), '#96201d'));

    // 等待至少一台中继握手完成（JS 侧自己 race 超时）
    await withTimeout(node.online(), 15000, '连接中继');
    $('node-state').className = 'pill ok';
    $('node-state').textContent = '在线';
    $('btn-send').disabled = false;
    $('btn-stop').disabled = false;
    log('已连上至少一台中继，可以收发消息了');
  } catch (e) {
    if (node) node.shutdown();
    node = null;
    $('node-state').className = 'pill bad';
    $('node-state').textContent = '失败';
    $('btn-start').disabled = false;
    log('启动失败：' + (e?.message ?? e), '#96201d');
    log('提示：本地 http://localhost 是安全上下文，可以连 wss://；若用 IP 访问需 HTTPS。', '#8a8a84');
  }
};

function handleEvent(ev) {
  switch (ev.type) {
    case 'relayStatus':
      renderStatus(ev.relays);
      log(`中继状态更新：${ev.relays.map((r) => r.url.replace('https://', '') + (r.connected ? '✓' : '✗')).join(' ')}`, '#6b6b6b');
      break;
    case 'peerConnected':
      log(`对端连入：${ev.from}`);
      break;
    case 'message':
      log(`← ${ev.from.slice(0, 12)}…: ${ev.text}`, '#14682f');
      break;
    case 'error':
      log('错误：' + ev.message, '#96201d');
      break;
    default:
      log('事件：' + JSON.stringify(ev));
  }
}

$('btn-send').onclick = async () => {
  const peer = $('peer-id').value.trim();
  const relay = $('peer-relay').value.trim();
  const text = $('msg').value;
  if (!peer || !relay || !text) return log('对端 ID / 中继 / 消息都要填', '#96201d');
  try {
    log(`→ ${peer.slice(0, 12)}…: ${text}`);
    const res = await node.send(peer, relay, text);
    log('投递结果：' + res);
    $('msg').value = '';
  } catch (e) {
    log('发送失败：' + (e?.message ?? e), '#96201d');
  }
};

$('btn-stop').onclick = () => {
  if (node) node.shutdown();
  node = null;
  $('node-state').className = 'pill wait';
  $('node-state').textContent = '已关闭';
  $('btn-send').disabled = true;
  $('btn-stop').disabled = true;
  $('btn-start').disabled = false;
  log('节点已关闭');
};

$('btn-copy').onclick = async () => {
  const id = $('my-id').textContent;
  if (!id || id === '—') return;
  try {
    await navigator.clipboard.writeText(id);
    log('已复制本机 ID');
  } catch (error) {
    log('复制失败：' + (error?.message ?? error), '#96201d');
  }
};

// 无头浏览器/自动化用：访问 ?autostart=1 时自动探测并启动节点
const AUTOSTART = new URLSearchParams(location.search).has('autostart');

function snapshot() {
  return {
    node: $('node-state')?.textContent,
    myId: $('my-id')?.textContent,
    probe: $('probe-state')?.textContent,
    relayRows: $('relay-rows')?.innerText,
    status: $('status-rows')?.innerText,
    log: $('log')?.innerText,
    console: consoleLines.join('\n'),
  };
}

// 回传状态，供无头环境采集（同一源的 POST，收集端自己打印）
async function reportState(tag) {
  if (!AUTOSTART) return;
  try {
    await fetch('./__result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, ...snapshot() }),
    });
  } catch {
    /* 收集端没开就算了 */
  }
}

async function autostart() {
  if (!AUTOSTART || !relayCfg) return;
  log('autostart：开始探测中继');
  await $('btn-probe').onclick();
  await reportState('probed');
  // 诊断：为什么拿到/拿不到 RTT（CORS 头 + Resource Timing 明细）
  for (const r of relayCfg.relays.filter((relay) => relay.enabled !== false)) {
    const d = await diagnoseRelay(r);
    log('诊断 ' + r.id + '：' + JSON.stringify(d));
  }
  log('autostart：启动节点');
  await $('btn-start').onclick();
  await reportState('started');
  setInterval(() => reportState('tick'), 3000);
}

boot().then(autostart);
