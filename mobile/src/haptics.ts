/**
 * 震动反馈。
 *
 * ## 为什么用 RN 内置的 `Vibration` 而不是 expo-haptics
 *
 * `expo-haptics` 能给更细腻的触感（轻/中/重、"选择"式反馈），但：
 *
 *   1. 它要**多装一个原生依赖**（现在这个项目每个原生依赖都要
 *      想清楚值不值 —— `.so` 已经 8 MB 了）；
 *   2. 它的细腻反馈主要受益在 iPhone 的 Taptic Engine 上，
 *      而本项目**只出 Android arm64**（见 build-android-so.yml）；
 *   3. `Vibration.vibrate()` 在 Android 上是标准 API，零依赖，
 *      且能给出**时长可控**的反馈 —— 够用了。
 *
 * 如果将来要出 iOS 版，再换 expo-haptics 是局部改动（只有这个文件）。
 *
 * ## 一处容易忽略的约束
 *
 * ⚠️ **`Vibration` 会受系统"震动"总开关与勿扰模式影响**，
 *    但 JS 侧**读不到**这个状态 —— 所以不能"先判断再震"，
 *    只能**直接调用**，让系统决定要不要真的震。
 *    这不是 bug，是平台设计；别试图自己判断。
 */

import { Platform, Vibration } from 'react-native';
import { getSettings, type Settings } from './settings';

/** 哪种场合的震动 */
export type HapticScene = 'message' | 'file' | 'join';

/** 场景 → 该读哪个开关 */
const SCENE_FLAG: Record<HapticScene, keyof Settings> = {
  message: 'hapticsOnMessage',
  file: 'hapticsOnFile',
  join: 'hapticsOnJoin',
};

/**
 * 不同场景用**不同的节奏**，让它不看屏幕也能分辨发生了什么：
 *
 * - `message` 短促一下（40ms）：最常发生，要轻
 * - `file`    两下短（30+60+30）：文件是"有实体"的事，给个辨识度
 * - `join`    一下稍长（80ms）：进房是明确的状态切换
 *
 * ⚠️ 时长**不要超过 100ms**：超过会被系统当成"提醒"而非"反馈"，
 *    而且连着来几条消息时会震得手麻。
 */
const PATTERN: Record<HapticScene, number | number[]> = {
  message: 40,
  file: [30, 60, 30],
  join: 80,
};

/**
 * 触发一次震动（受设置开关控制）。
 *
 * ⚠️ 这个函数**永远不会抛**：震动失败不该影响消息显示。
 *    而且它读的是同步缓存（见 settings.ts），不需要 await。
 */
export function haptic(scene: HapticScene): void {
  try {
    if (!getSettings()[SCENE_FLAG[scene]]) return;
    // Android 上数字 = 毫秒；数组 = 轮流 震动/停顿
    if (Platform.OS === 'android') {
      Vibration.vibrate(PATTERN[scene]);
    } else {
      // iOS 的 vibrate 忽略时长参数（只有固定的一下），传数字即可
      Vibration.vibrate();
    }
  } catch {
    /* 设备没有振动器 / 权限被拒 —— 静默跳过 */
  }
}
