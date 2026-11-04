// 斗鱼条目归一化（列表 rl[] → browse 网格可直接消费的 item）。
//
// 事实来源：本机 2026-11-04 真机同源实测（node fetch，同 UA/Referer），非推测：
//
// 1) 封面三档（rpic.douyucdn.cn，实测像素/体积）：
//      rs16  → /dy1  320x180  26 KB   ← 网格每格 160x110（2x=320x220）**刚好够**，默认用它
//      rs1   → /dy2  400x400  53 KB   ← 注意实测是**方形**不是宽屏，裁剪后反而损失左右
//      原始  不带后缀  899x500 274 KB  ← 太大，笔端内存/带宽都不划算，不用
//    结论：默认 rs16（省一半带宽 + 像素密度匹配）；播放页要大图再传 'rs1'。
//
// 2) 头像（apic.douyucdn.cn/upload/<av>_<档>.jpg，实测）：
//      _small.jpg  48x48   3 KB
//      _middle.jpg 120x120 11 KB  ← 默认
//      _big.jpg    200x200 23 KB
//    av 字段是**不带后缀的相对路径**（avatar_v3/202102/<hash>），必须自己拼 `_middle.jpg`；
//    直接拼 `.jpg` 会 404（实测）。
//
// 3) 协议：rpic/apic.douyucdn.cn 的 http 与 https 实测都 200，但框架 ImageLoader 基于 curl
//    且不带回环 CA 库 → 统一降 http，避免 https 失败成灰块。
import { logWarn } from '../storage.js';

// 图片 CDN 域名（只对这两个域名做 http 降级/路径归一，其它外链不动）
export const COVER_CDN = 'https://rpic.douyucdn.cn';
export const AVATAR_CDN = 'https://apic.douyucdn.cn/upload/';

const DOUYUCON_HOST_RE = /^(?:[a-z0-9-]+\.)*douyucdn\.cn(:\d+)?$/i;

/**
 * 图片 URL 归一：协议相对补全 → douyucdn 域名降 http；其它域名原样。
 * @param {string} url
 * @returns {string}
 */
export function normalizeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  if (!u) return '';
  if (u.indexOf('//') === 0) {
    const rest = u.slice(2);
    const slash = rest.indexOf('/');
    const host = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : rest.slice(slash);
    if (DOUYUCON_HOST_RE.test(host)) return 'http://' + host + path;
    return 'https:' + u;
  }
  const m = /^(https?):\/\/([^/]+)(\/[^?#]*)?([?#].*)?$/i.exec(u);
  if (m) {
    if (DOUYUCON_HOST_RE.test(m[2])) return 'http://' + m[2] + (m[3] || '') + (m[4] || '');
    return u;
  }
  return u;
}

/**
 * 从 rl[] 条目挑封面。设备 960x266 逻辑宽、5 列网格（每格约 160x110），
 * rs16=320x180 正好 2x 像素密度 → 默认 rs16；要更大（播放页/详情）传 'rs1'。
 * @param {object} raw  斗鱼 rl[] 原始条目
 * @param {'rs16'|'rs1'} [size]
 * @returns {string}
 */
export function pickCover(raw, size) {
  if (!raw || typeof raw !== 'object') return '';
  const wantBig = size === 'rs1';
  const a = wantBig ? raw.rs1 : raw.rs16;
  const b = wantBig ? raw.rs16 : raw.rs1;
  return normalizeImageUrl(a || b || '');
}

/**
 * 头像：av 是相对路径（无扩展名），按档位拼后缀；也兼容已是完整 URL 的（搜索 roomResult 里是完整 URL）。
 * @param {string} av
 * @param {'small'|'middle'|'big'} [size]
 * @returns {string}
 */
export function normalizeAvatar(av, size) {
  if (typeof av !== 'string') return '';
  const s = av.trim();
  if (!s) return '';
  const suffix = '_' + (size === 'small' ? 'small' : size === 'big' ? 'big' : 'middle') + '.jpg';
  // 已是完整 URL：若带 _small/_middle/_big 就换档，否则补档
  if (/^https?:\/\//i.test(s) || s.indexOf('//') === 0) {
    const base = s.replace(/_(?:small|middle|big)\.jpg$/i, '');
    return normalizeImageUrl(/\.jpg$/i.test(base) ? base : base + suffix);
  }
  return normalizeImageUrl(AVATAR_CDN + s.replace(/^\/+/, '') + suffix);
}

/**
 * 人气数 → "536.1万" / "1.2亿"；非正数 → ''（列表里 ol=0 表示未开播）。
 * @param {number} n
 * @returns {string}
 */
export function formatOnline(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(Math.floor(v));
}

// 斗鱼房间标题常带不可见/全角空白，统一压一下；不做 HTML 解码（斗鱼 rn 无高亮标签）
function cleanText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * rl[] 原始条目 → 统一 item。
 * 统一结构见 docs/douyu-integration.md §2（browse 网格直接消费）。
 *
 * 关于 isLive：契约写的是 `isLive:true`，这里**照契约恒为 true**（斗鱼列表本来就是直播列表），
 * 另外附 `offline` 布尔。依据：实测 rl[] 里 ol=0 的房间取流会返回 error=-15「非法请求」
 * （257 个房间抽样 13 个 ol=0，全部 -15）→ ol=0 等价于未开播，UI 可据此置灰/过滤，
 * 由 feed.js 决定是否剔除（默认剔除，避免点进去必然失败）。
 *
 * @param {object} raw
 * @param {{size?: 'rs16'|'rs1'}} [opts]
 * @returns {object|null}
 */
export function normalizeRoom(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const rid = Number(raw.rid);
  if (!isFinite(rid) || rid <= 0) return null;
  const o = opts || {};
  const title = cleanText(raw.rn) || cleanText(raw.nn) || ('房间' + rid);
  const online = Number(raw.ol) > 0 ? Number(raw.ol) : 0;
  return {
    site: 'douyu',
    rid: rid,
    title: title,
    streamer: cleanText(raw.nn),
    cover: pickCover(raw, o.size),
    avatar: normalizeAvatar(raw.av),
    category: cleanText(raw.c2name) || cleanText(raw.c2name_display),
    online: online,
    onlineText: formatOnline(online),
    isLive: true,
    // 附加字段（契约外，供 UI 置灰/过滤）
    offline: online <= 0,
    cid2: Number(raw.cid2) || 0
  };
}

/**
 * rl[] → item[]（丢弃 rid 不合法的条目，保留顺序）。
 * @param {Array} rl
 * @param {{size?: 'rs16'|'rs1'}} [opts]
 * @returns {Array}
 */
export function normalizeRoomList(rl, opts) {
  if (!Array.isArray(rl)) {
    if (rl) logWarn('[douyu] rl 非数组: ' + typeof rl);
    return [];
  }
  const out = [];
  for (let i = 0; i < rl.length; i++) {
    const it = normalizeRoom(rl[i], opts);
    if (it) out.push(it);
  }
  return out;
}
