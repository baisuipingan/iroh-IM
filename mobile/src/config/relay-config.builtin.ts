/* ============================================================================
 * 内置兜底的中继配置 —— **只在拉取 `relay-config.json` 失败时生效**。
 *
 * ⚠️ 这是最后一道防线，不追求新鲜，追求"一定能连上"：
 *    与 `frontend/relay-config.json` **人工保持同步**（换中继时两边都要看）。
 *    正常路径是运行期拉取，改中继**不需要**重新发版 App。
 * ==========================================================================*/

export const BUILTIN_RELAY_CONFIG = {
  relays: [
    { id: 'hk-1', url: 'https://iroh1.editor.vip:15443', enabled: true, region: 'HK' },
    { id: 'eu-1', url: 'https://iroh2.editor.vip:15443', enabled: true, region: 'EU' },
    { id: 'fr-1', url: 'https://iroh3.editor.vip:15443', enabled: true, region: 'FR' },
  ],
  anchor: {
    id: '5bcc4ea3bb56f17041390a9f171bb03a16f107f95ecb93097f80a985845aaab6',
    relay: 'https://iroh1.editor.vip:15443',
  },
  relay_token: '44d51ffb6ddab961c6c8cdfe802e0752e0dee3b5cb486916',
};
