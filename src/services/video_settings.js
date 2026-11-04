// 直播画质偏好（「我的」菜单 → 直播画质）
//
// 面板 480x960@59.88Hz，硬解实测 720p60 实时 57.95fps、1080p60 实时 56.20fps，
// 所以 60fps 内容能真正呈现；但 60fps 档码率约为同分辨率 30fps 的两倍，弱网下
// 更容易缓冲。斗鱼的码率档（rate）由 douyu/api.js 的 DEFAULT_RATE 决定，
// 这里的 fpsCap 只控制 native 侧的渲染上限（videorate 只封顶、不插帧）。
import { getJson, setJson } from './storage.js';

export const VIDEO_SETTINGS_KEY = 'douyu_video_settings';
export const VIDEO_SETTINGS_VERSION = 2;

/* 直播画质档。
 * 斗鱼侧只请求固定码率（rate=2 高清 900kbps，见 douyu/api.js），分辨率由服务端定，
 * 本地能调的只有渲染帧率上限，所以每个档位只带 fpsCap（0 = 不限制）与显示文案。 */
export const LIVE_QUALITY_OPTIONS = [
  { id: '480p30', label: '480p 30fps（省流）', fpsCap: 30 },
  { id: '720p30', label: '720p 30fps', fpsCap: 30 },
  { id: '720p60', label: '720p 60fps', fpsCap: 0 }
];

/* 按 id 查档位，查不到退回该列表的默认档。
 * 旧存储里的 'auto' / '1080p' 等已不存在的 id 会落到 fallback（默认 720p60），
 * 而不是 list[0]（列表首项是省流档，比默认更低，用户会发现画质莫名变差）。 */
const findById = (list, id, fallback) =>
  list.find((x) => x.id === id) ||
  list.find((x) => x.id === fallback) ||
  list[0];

export const DEFAULT_VIDEO_SETTINGS = {
  version: VIDEO_SETTINGS_VERSION,
  liveQuality: '720p60'
};

/* 反序列化：任何脏数据都退回默认值，绝不因为一条坏记录让播放起不来。
 * 老版本（version<2 或还带着点播字段）一律按「只认 liveQuality」重新归一。 */
export function normalizeVideoSettings(raw) {
  const base = Object.assign({}, DEFAULT_VIDEO_SETTINGS);
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: VIDEO_SETTINGS_VERSION,
    liveQuality: findById(LIVE_QUALITY_OPTIONS, raw.liveQuality,
                          DEFAULT_VIDEO_SETTINGS.liveQuality).id
  };
}

export async function loadVideoSettings() {
  return normalizeVideoSettings(await getJson(VIDEO_SETTINGS_KEY, null));
}

export function saveVideoSettings(s) {
  return setJson(VIDEO_SETTINGS_KEY, normalizeVideoSettings(s));
}

/* 点「画质」行时轮转到下一个选项（falcon 没有原生下拉，逐项轮转最省事，
 * 且状态永远可见，不需要弹层）。 */
export function nextOptionId(list, id) {
  const arr = Array.isArray(list) && list.length ? list : [{ id: id }];
  const i = arr.findIndex((x) => x.id === id);
  return arr[(i < 0 ? 0 : i + 1) % arr.length].id;
}

/* 直播的渲染帧率上限（0 = 不限制）。 */
export function liveFpsCapFor(settings) {
  const s = normalizeVideoSettings(settings);
  return findById(LIVE_QUALITY_OPTIONS, s.liveQuality,
                 DEFAULT_VIDEO_SETTINGS.liveQuality).fpsCap;
}

/* 菜单里显示的文字（模板不能直接调模块函数，由页面转发）。 */
export function liveQualityLabel(settings) {
  const s = normalizeVideoSettings(settings);
  return findById(LIVE_QUALITY_OPTIONS, s.liveQuality,
                 DEFAULT_VIDEO_SETTINGS.liveQuality).label;
}
