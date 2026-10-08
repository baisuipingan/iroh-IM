/** pi-sdk brain 的 faux 冒烟：真实 pi 会话 + 本地零网络 provider（对齐 skill H03）。
 *
 * 为什么用直接文件路径 import pi-ai：pi-coding-agent 带 npm-shrinkwrap，
 * 本项目里 pi-ai 被嵌套在 `pi-coding-agent/node_modules/` 下、顶上没有提升，
 * "@earendil-works/pi-ai" 对用户代码不可解析——H03 的标准写法在这里走不通。
 * 直接指向嵌套 dist 文件 = 与 pi-coding-agent **同一个模块实例**，
 * api-registry 才是共享的（registry 分裂会让 faux 失效）。
 */
import { pathToFileURL } from 'node:url';

const REPO = process.argv[2];
const AGENT_PI = `${REPO}/agent-pi`;
const SDK = `${AGENT_PI}/node_modules/@earendil-works/pi-coding-agent`;
const PI_AI = `${SDK}/node_modules/@earendil-works/pi-ai/dist`;

const { registerFauxProvider } = await import(pathToFileURL(`${PI_AI}/compat.js`).href);
const { fauxAssistantMessage } = await import(pathToFileURL(`${PI_AI}/providers/faux.js`).href);
const { ModelRuntime } = await import(pathToFileURL(`${SDK}/dist/index.js`).href);
const { createPiSdkBrain } = await import(pathToFileURL(`${AGENT_PI}/src/brains/pi-sdk.ts`).href);

const fails = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}` + (cond ? '' : `  [${detail}]`));
  if (!cond) fails.push(name);
}

process.env.PI_OFFLINE = '1';

// 1) 注册 faux provider + 给 ModelRuntime 配上同款（H03 最大陷阱：只给 model 不够）
const faux = registerFauxProvider();
const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
modelRuntime.registerProvider(faux.models[0].provider, {
  baseUrl: faux.models[0].baseUrl,
  apiKey: 'faux-key',
  api: faux.api,
  models: faux.models.map((m) => ({
    id: m.id, name: m.name, api: m.api, reasoning: m.reasoning,
    input: m.input, cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl,
  })),
});
console.log('✅ faux provider 注册完成（provider=%s, api=%s）', faux.models[0].provider, faux.api);

// 2) 组装 brain（复用真实构造路径：默认人设 + noTools + inMemory 会话）
const ctx = {
  say: async (text) => ({ id: 'x', ts: 0 }),
  history: async () => ({}),
  status: async () => ({}),
  log: (...args) => console.log('   〔ctx〕', ...args),
};
const brain = await createPiSdkBrain({
  agentNick: '冒烟助手',
  extraSessionOptions: { model: faux.getModel(), modelRuntime },
  log: (...args) => console.log('   〔brain〕', ...args),
});
console.log('✅ pi-sdk brain 已创建（默认人设 + noTools:all）');

function msg(text, nickname = '甲') {
  return {
    room: '冒烟房', id: `m${Math.random()}`, from: 'peer1', nickname, text, ts: 0,
    agentNick: '冒烟助手',
    raw: { id: `m${Math.random()}`, from: 'peer1', nickname, text, ts: 0 },
  };
}

// 3) 第一轮：队列第 1 条响应 → 回复原文
faux.setResponses([fauxAssistantMessage('Faux 回复一：你好呀')]);
let r = await brain.onMessage(msg('你好'), ctx);
check('第 1 轮返回不空', typeof r === 'string' && r.length > 0, String(r));
check('第 1 轮文本来自 faux', r === 'Faux 回复一：你好呀', String(r));

// 4) 第二轮：换下一条响应（会话仍同一个 → 有记忆）
faux.setResponses([fauxAssistantMessage('这是第二条（有记忆会话）')]);
r = await brain.onMessage(msg('再说点什么', '乙'), ctx);
check('第 2 轮返回不空', typeof r === 'string' && r.length > 0, String(r));
check('第 2 轮文本来自 faux', r === '这是第二条（有记忆会话）', String(r));

// 5) 第三轮：队列耗尽 → 必须走错误路径返回 null（不炸、不回）
faux.setResponses([]);
r = await brain.onMessage(msg('来点第四轮'), ctx);
check('队列耗尽 → 返回 null（错误路径）', r === null, String(r));

// 6) 工厂响应：动态生成（第 4 条），验证会话连续性
faux.appendResponses([
  (context, _options, state, model) => fauxAssistantMessage(`call#${state.callCount} msgs=${context.messages.length} model=${model.id}`),
]);
r = await brain.onMessage(msg('工厂响应来一轮'), ctx);
check('工厂响应返回不空', typeof r === 'string' && r.startsWith('call#'), String(r));
const n = r.match(/msgs=(\d+)/);
check('会话有积累（ messages 数 > 察觉最低 ）', n && Number(n[1]) >= 7, String(r));
console.log('   工厂回复：', r);

check('faux 调用计数 = 4', faux.state.callCount === 4, String(faux.state.callCount));

await brain.close();
faux.unregister();

if (fails.length) {
  console.log(`\n❌ 失败 ${fails.length} 项：${fails}`);
  process.exit(1);
}
console.log('\n✅ pi-sdk faux 冒烟全部通过');
