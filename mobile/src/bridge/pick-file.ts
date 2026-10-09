/**
 * 选一个文件并发出去。
 *
 * ## 为什么用 expo-document-picker 而不是自己写 SAF
 *
 * Android 10+ 选本地文件必须走系统选择器（SAF），它要在 **Activity** 上注册
 * `ActivityResultLauncher` 并处理回调。自己用 JNI + Expo Modules 的
 * Activity Result API 也能做，但要实现一个自定义 Contract（输入类型受
 * `Serializable` 限制，Uri 得自己包一层）+ 处理"Activity 被回收"等边界。
 *
 * `expo-document-picker` 是官方包，一行调用就返回 `{uri, name, size, mimeType}`
 * —— 且返回的 `uri` 正好是我们要的 `content://`（原生侧按它 open fd）。
 * 原生层因此只负责"拿到 uri 之后的事"（`publishFile(uri, …)`），
 * 职责更清楚。
 *
 * ## 关于 name / mime 的取值
 *
 * picker 返回的 `name` 可能为空（某些 provider 不给 `DISPLAY_NAME`），
 * 所以要有兜底 —— 空名字会让对方的文件卡片显示成空白。
 */
import * as DocumentPicker from 'expo-document-picker';

export interface PickedFile {
  uri: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * 打开系统文件选择器。用户取消返回 `null`。
 *
 * ⚠️ 不在这里做"发送" —— 选文件和发送是两件事，
 *    由调用方在拿到结果后再触发（便于插入"发布中"的 UI 状态）。
 */
export async function pickFile(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    // 用 copyToCacheDirectory: false —— 直接拿原始 content:// uri。
    // 设 true 的话 expo 会把文件复制进缓存目录再给一个 file:// uri，
    // 多一次全量拷贝（大文件很痛），而我们本来就只需要能 open 的 fd。
    copyToCacheDirectory: false,
    multiple: false,
    type: '*/*',
  });

  if (res.canceled) return null;
  const asset = res.assets?.[0];
  if (!asset) return null;

  const rawName = (asset.name ?? '').trim();
  // 名字兜底：从 uri 末尾猜一个，再不行给个通用名
  const fromUri = decodeURIComponent(asset.uri.split('/').pop() ?? '').split('?')[0];
  const name = rawName || fromUri || 'file';

  return {
    uri: asset.uri,
    name,
    // 有些 provider 不给 size（返回 null）→ 传 0 让原生侧自己从 fd 算
    size: typeof asset.size === 'number' ? asset.size : 0,
    mime: asset.mimeType || 'application/octet-stream',
  };
}
