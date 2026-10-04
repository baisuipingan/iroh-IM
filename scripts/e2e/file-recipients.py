"""独立三端验证文件分享：按人拒绝、成功、失败、取消、重试和详情重建。"""

import base64
import importlib.util
import json
import os
import pathlib
import sys
import time

saved_args = sys.argv
sys.argv = ['file-recipients']
spec = importlib.util.spec_from_file_location('transfer_test', 'scripts/transfer-test.py')
tt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tt)
sys.argv = saved_args
tt.CDP = os.environ.get('E2E_CDP', 'http://127.0.0.1:9222')
site = os.environ.get('E2E_SITE', 'http://127.0.0.1:8099')
room = f'file-recipients-{time.time_ns()}'


class Browser(tt.Page):
    def __init__(self):
        self.ws = tt.WS(tt.http_json(tt.CDP + '/json/version')['webSocketDebuggerUrl'])
        self._id = 0


browser = Browser()
contexts = []


def wait_until(page, expression, timeout=45):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = page.ev(expression)
            if last:
                return last
        except Exception as error:
            last = str(error)
        time.sleep(0.3)
    raise TimeoutError(f'等待超时：{expression}（最后 {last!r}）')


def boot(nickname):
    context = browser.call('Target.createBrowserContext')['browserContextId']
    contexts.append(context)
    target = browser.call('Target.createTarget', {'url': 'about:blank', 'browserContextId': context})
    page = tt.Page(target['targetId'])
    page.call('Page.enable')
    page.call('Runtime.enable')
    page.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 960, 'deviceScaleFactor': 1, 'mobile': False})
    page.call('Page.navigate', {'url': f'{site}/?autostart=1&room={room}'})
    wait_until(page, f'window.__state?.().joined === {json.dumps(room)}', 120)
    page.ev(f'window.__net.client.call("setNickname", {json.dumps(nickname)})')
    page.ev('window.__useOpfs = true')
    return page


def transfer_expression(file_id):
    return f'window.__transfers().find(transfer => transfer.file_id === {json.dumps(file_id)})'


def snapshot(page, file_id):
    return page.ev(transfer_expression(file_id))


def wait_recipient(page, file_id, peer_id, state, timeout=45):
    return wait_until(page, f'{transfer_expression(file_id)}?.recipients?.some(recipient => '
                      f'recipient.id === {json.dumps(peer_id)} && recipient.state === {json.dumps(state)})', timeout)


def wait_completed(page, file_id, peer_id):
    started = time.monotonic()
    progress_deadline = started + 45
    last_done = -1
    while time.monotonic() - started < 240:
        recipient = next((entry for entry in snapshot(page, file_id)['recipients'] if entry['id'] == peer_id), None)
        if recipient:
            if recipient['state'] == 'done':
                return
            if recipient['state'] != 'sending':
                raise RuntimeError(f'接收未成功：{recipient}')
            if recipient['done'] > last_done:
                last_done = recipient['done']
                progress_deadline = time.monotonic() + 45
        if time.monotonic() > progress_deadline:
            raise TimeoutError(f'接收持续无进度：{recipient}')
        time.sleep(0.4)
    raise TimeoutError(f'接收总耗时超过四分钟：{recipient}')


def send(sender, receivers, name, size=512 * 1024):
    meta = sender.ev(f'''(async () => {{
      const data = new Uint8Array({size});
      for (let offset = 0; offset < data.length; offset += 16384) {{
        data.fill((offset / 16384) & 255, offset, Math.min(offset + 16384, data.length));
      }}
      return window.__sendFile(new File([data], {json.dumps(name)}), {json.dumps(room)});
    }})()''')
    for page in receivers:
        wait_until(page, f'{transfer_expression(meta["file_id"])}?.state === "invited" || '
                        f'({transfer_expression(meta["file_id"])}?.state === "archived" && '
                        f'{transfer_expression(meta["file_id"])}?.avail === "live")')
        if snapshot(page, meta['file_id'])['state'] == 'archived':
            page.ev('import("./js/ui/filetransfer.js").then(({fileTransfer}) => '
                    f'fileTransfer.openArchived({json.dumps(meta["file_id"])}))')
        wait_until(page, f'{transfer_expression(meta["file_id"])}?.state === "invited"')
    return meta['file_id']


def reject(page, file_id):
    page.ev(f'import("./js/ui/filetransfer.js").then(({{fileTransfer}}) => '
            f'fileTransfer.reject({json.dumps(file_id)}))')


def accept(page, file_id):
    page.fire(f'window.__acceptFile({json.dumps(file_id)})')


def card_snapshot(page, file_id):
    return page.ev(f'''(() => {{
      const card = [...document.querySelectorAll('.msg--file')].find(element =>
        element.dataset.fileId === {json.dumps(file_id)});
      const details = card.querySelector('.filecard__recipients');
      return {{
        summary: card.querySelector('.filecard__state').textContent,
        errors: card.querySelectorAll('.filecard__err').length,
        bar: getComputedStyle(card.querySelector('.filecard__bar, .imgcard__bar')).display,
        open: details?.open,
        rows: [...card.querySelectorAll('.filecard__recipient')].map(element => ({{
          peer: element.dataset.peer, state: element.dataset.state,
          name: element.querySelector('.filecard__recipient-name').textContent,
          color: getComputedStyle(element.querySelector('.filecard__recipient-state')).color,
          progress: element.querySelector('progress')?.value,
        }})),
        errorColor: getComputedStyle(document.documentElement).getPropertyValue('--c-bad').trim(),
      }};
    }})()''')


try:
    sender = boot('发送者')
    first = boot('接收者 A')
    second = boot('接收者 B')
    first_id = first.ev('window.__state().myId')
    second_id = second.ev('window.__state().myId')
    receivers = [first, second]

    file_id = send(sender, receivers, 'reject-before.png')
    tt.check('分享不把全房成员计为必须接收的人', snapshot(sender, file_id)['peers'] == 0)
    reject(first, file_id)
    wait_recipient(sender, file_id, first_id, 'rejected')
    before = snapshot(sender, file_id)
    tt.check('第一人拒绝后文件仍处于分享状态', before['state'] == 'shared' and before['available'])
    tt.check('拒绝独立计数，不算发送失败', before['peersRejected'] == 1 and before['peersFailed'] == 0)
    tt.check('另一个接收者仍能选择接收', snapshot(second, file_id)['state'] == 'invited')
    sender.ev('document.querySelector(".filecard__recipients").open = true')
    accept(second, file_id)
    wait_until(second, f'{transfer_expression(file_id)}?.state === "done"')
    wait_recipient(sender, file_id, second_id, 'done')
    view = card_snapshot(sender, file_id)
    tt.check('图片卡片同时汇总成功和拒绝', '1 人接收完成' in view['summary'] and '1 人拒绝接收' in view['summary'])
    tt.check('拒绝不残留整张卡片的红色错误', view['errors'] == 0)
    tt.check('拒绝行使用中性色而非失败样式', sender.ev(f'''(() => {{
      const card = [...document.querySelectorAll('.msg--file')].find(element => element.dataset.fileId === {json.dumps(file_id)});
      const status = card.querySelector('[data-state="rejected"] .filecard__recipient-state');
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg-faint)';
      card.append(probe);
      const neutral = getComputedStyle(status).color === getComputedStyle(probe).color;
      probe.remove();
      return neutral;
    }})()'''))
    tt.check('发送侧不显示误导性的总进度条', view['bar'] == 'none')
    tt.check('详情按身份区分两位接收者', {row['peer'] for row in view['rows']} == {first_id, second_id})
    tt.check('实时更新不折叠已展开的详情', view['open'])
    wait_until(sender, 'document.querySelector(".filecard__recipient-name").textContent.includes("接收者")')
    tt.check('详情显示接收者昵称', all('接收者' in row['name'] for row in card_snapshot(sender, file_id)['rows']))
    verified = second.ev('window.__verifyOpfs("reject-before.png", 524288, 16384)')
    tt.check('另一人收到的文件逐字节正确', verified['ok'], str(verified))
    reject(first, file_id)
    tt.check('重复拒绝不增加人数或覆盖他人的成功', snapshot(sender, file_id)['peers'] == 2 and snapshot(sender, file_id)['peersDone'] == 1)

    screenshot = os.environ.get('E2E_SCREENSHOT')
    if screenshot:
        path = pathlib.Path(screenshot)
        path.parent.mkdir(parents=True, exist_ok=True)
        sender.call('Page.bringToFront')
        time.sleep(1)
        image = sender.call('Page.captureScreenshot', {'format': 'png'})['data']
        path.write_bytes(base64.b64decode(image))

    after_id = send(sender, receivers, 'reject-after.bin')
    accept(first, after_id)
    wait_recipient(sender, after_id, first_id, 'done')
    reject(second, after_id)
    wait_recipient(sender, after_id, second_id, 'rejected')
    tt.check('先成功后拒绝也保留两人的独立结果', snapshot(sender, after_id)['state'] == 'shared' and snapshot(sender, after_id)['peersDone'] == 1)
    tt.check('普通文件卡片也显示混合结果', '1 人拒绝接收' in card_snapshot(sender, after_id)['summary'])

    both_id = send(sender, receivers, 'all-rejected.bin')
    for page in receivers:
        reject(page, both_id)
    wait_until(sender, f'{transfer_expression(both_id)}?.peersRejected === 2')
    tt.check('全部拒绝也不是技术失败，文件仍可分享', snapshot(sender, both_id)['state'] == 'shared' and snapshot(sender, both_id)['peersFailed'] == 0)

    failed_id = send(sender, receivers, 'retry.bin', 2 * 1024 * 1024)
    sender.ev('window.__setStopAfterChunks(32)')
    accept(first, failed_id)
    wait_recipient(sender, failed_id, first_id, 'failed')
    wait_until(first, f'{transfer_expression(failed_id)}?.state === "paused"')
    tt.check('技术失败只落在对应接收者详情', card_snapshot(sender, failed_id)['rows'][0]['state'] == 'failed' and card_snapshot(sender, failed_id)['errors'] == 0)
    sender.ev('window.__setStopAfterChunks(0)')
    accept(second, failed_id)
    wait_recipient(sender, failed_id, second_id, 'done')
    tt.check('一人技术失败不妨碍另一人接收', snapshot(sender, failed_id)['peersDone'] == 1 and snapshot(sender, failed_id)['peersFailed'] == 1)
    sender.ev(f'import("./js/ui/filetransfer.js").then(({{fileTransfer}}) => fileTransfer.resend({json.dumps(failed_id)}))')
    wait_recipient(sender, failed_id, first_id, 'waiting')
    tt.check('重新邀请不清掉已成功接收的记录', snapshot(sender, failed_id)['peersDone'] == 1)
    accept(first, failed_id)
    wait_recipient(sender, failed_id, first_id, 'done')
    verified = first.ev('window.__verifyOpfs("retry.bin", 2097152, 16384)')
    tt.check('失败者续传成功且旧失败状态清除', verified['ok'] and snapshot(sender, failed_id)['peersFailed'] == 0)
    tt.check('接收侧续传完成后也清除旧错误', card_snapshot(first, failed_id)['errors'] == 0)

    cancel_id = send(sender, receivers, 'cancel.bin', 8 * 1024 * 1024)
    accept(first, cancel_id)
    wait_until(sender, f'{transfer_expression(cancel_id)}?.recipients?.some(recipient => recipient.state === "sending" && recipient.done > 0)')
    view = card_snapshot(sender, cancel_id)
    tt.check('接收详情展示个人进度', view['rows'][0]['progress'] is not None)
    first.ev(f'import("./js/ui/filetransfer.js").then(({{fileTransfer}}) => fileTransfer.cancel({json.dumps(cancel_id)}))')
    wait_recipient(sender, cancel_id, first_id, 'cancelled')
    accept(second, cancel_id)
    wait_completed(sender, cancel_id, second_id)
    tt.check('取消与失败分开统计且不影响他人', snapshot(sender, cancel_id)['peersCancelled'] == 1 and snapshot(sender, cancel_id)['peersDone'] == 1 and snapshot(sender, cancel_id)['peersFailed'] == 0)

    rebuild = sender.ev(f'''(async () => {{
      const {{ timeline }} = await import('./js/ui/timeline.js');
      const {{ fileTransfer }} = await import('./js/ui/filetransfer.js');
      timeline.open('other-room', window.__state().myId);
      timeline.open({json.dumps(room)}, window.__state().myId);
      fileTransfer.rebuildCardsForRoom({json.dumps(room)});
      return [...document.querySelectorAll('.msg--file')].filter(element => element.dataset.fileId === {json.dumps(file_id)}).length;
    }})()''')
    tt.check('切房重建只保留一张卡片和独立结果', rebuild == 1 and len(card_snapshot(sender, file_id)['rows']) == 2)
    tt.check('重建后依然没有旧拒绝错误或总进度', card_snapshot(sender, file_id)['errors'] == 0 and card_snapshot(sender, file_id)['bar'] == 'none')
    isolated = sender.ev(f'''(async () => {{
      const {{ fileTransfer }} = await import('./js/ui/filetransfer.js');
      const before = JSON.stringify(window.__transfers());
      fileTransfer._updateOutgoing({{file_id: {json.dumps(file_id)}, room: 'other-room'}});
      return before === JSON.stringify(window.__transfers());
    }})()''')
    tt.check('其他房间的汇总不能覆盖接收详情', isolated)
except Exception:
    for label in ['sender', 'first', 'second']:
        page = locals().get(label)
        if page:
            print(f'{label} 诊断: {json.dumps(page.ev("window.__transfers()"), ensure_ascii=False)}', flush=True)
    raise
finally:
    for context in contexts:
        browser.call('Target.disposeBrowserContext', {'browserContextId': context})

print(f'\n总计 PASS={tt.PASS} FAIL={tt.FAIL}', flush=True)
sys.exit(1 if tt.FAIL else 0)
