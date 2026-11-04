// 斗鱼列表/搜索 adapter：推荐、分区房间、关键词搜索 → 统一 item 形态。
//
// 实测（2026-11-04，本机 node fetch，同 UA/Referer/Origin）：
//
// 1) 房间列表 GET /gapi/rkc/directory/mixList/{cid1}_{cid2}/{page}
//      → {code:0, msg:'success', data:{ct:{...}, rl:[...120], pgcnt:62}}
//    - **cid1 恒为 2**（doc §1）。分类树 subs 里的 cid1 是 {4,5,6,20,12}，不能直接用。
//    - 推荐 = `0_0`。实测 `2_0` 返回 **rl:[] 空列表**（code=0 骗人）→ cid2=0 必须走 0_0。
//    - 每页 120 条，pgcnt=62（推荐）。页码越界返回 200 + rl:[]（不是 4xx）→ 要自己判空收尾。
//    - 同一页多次请求结果一致；翻页正常（page2/3 首条 rid 各不相同）。
//
// 2) 搜索：`/japi/search/api/searchShow` 被风控（doc §1）→ 走 getSearchRec 兜底：
//      getSearchRec?kw=xx → data.{cateResult[], roomResult[], channelResult[]}
//      cateResult: [{cid(可用作 cid2), name, shortName, icon, showNum}]  ← 关键词→分类
//      roomResult: [{rid, nickName, cateName, avatar, isLive}] 6 条，**无封面 rs16/rn**
//    → 主路径：cateResult 取 cid2 → 拉该分类房间 → 本地按 title/streamer 过滤。
//      实测「王者」→ cateResult 命中 181(王者荣耀,435 间)，181 首页 120 条里标题/主播含"王者"的 10 条。
//    → 过滤后为空（关键词是分类名但没人写进标题，如「三角洲行动」）→ 返回该分类全部，标 via:'cate'。
//
// 3) 未开播判定：rl[].ol=0 → 取流必得 error=-15（257 间抽样 13 间 ol=0，全部 -15）。
//    默认 hideOffline=true 把这类房间剔掉，避免网格里出现点进去必然失败的格子；
//    需要原始列表时传 {hideOffline:false}。
import { logWarn } from '../storage.js';
import { douyuGetJson, DOUYU_HOST } from './api.js';
import { MIX_CID1, fetchCateByKeyword, fetchCategories } from './cate.js';
import { normalizeRoom, normalizeRoomList } from './normalize.js';

// 分类树直接透出（UI 从 feed.js 一个入口拿全，少一条 import 路径）
export { fetchCategories };

export const MIXLIST_PATH = '/gapi/rkc/directory/mixList';
export const RCMD_SEGMENT = '0_0'; // 推荐 cid1_cid2（实测 2_0 是空列表）
export const PAGE_SIZE = 120; // 服务端固定 120/页（实测）
export const MAX_PAGES = 500; // pgcnt 上界保护
// 搜索最多尝试几个候选分类（每个 120 条；笔端多拉几趟会明显变慢）
export const SEARCH_MAX_CATE = 2;

/**
 * 拼分区列表 URL（纯函数，便于对拍）。
 * cid2 <= 0 → 推荐 `0_0`；否则 `2_{cid2}`（cid1 恒为 2，见文件头）。
 * @param {number} cid2
 * @param {number} page 1 起
 * @returns {string}
 */
export function buildMixListUrl(cid2, page) {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const c = Math.floor(Number(cid2) || 0);
  const seg = c > 0 ? MIX_CID1 + '_' + c : RCMD_SEGMENT;
  return DOUYU_HOST + MIXLIST_PATH + '/' + seg + '/' + p;
}

/**
 * 拉一页房间。返回 { ok, items, page, total, error?, errorText? }，不 throw。
 *
 * `total` = 服务端 pgcnt（**总页数**，不是总条数；推荐实测 62）。
 * @param {number} cid2 0/空 = 推荐
 * @param {number} [page]
 * @param {{hideOffline?: boolean, size?: 'rs16'|'rs1'}} [opts]
 * @returns {Promise<{ok:boolean, items:Array, page:number, total:number, error?:*, errorText?:string}>}
 */
export async function fetchLiveList(cid2, page, opts) {
  const o = opts || {};
  const c = Math.floor(Number(cid2) || 0);
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const hideOffline = o.hideOffline !== false; // 默认剔除未开播

  const url = buildMixListUrl(c, p);
  const r = await douyuGetJson(url, { tag: 'mixList ' + (c > 0 ? '2_' + c : RCMD_SEGMENT) + '/' + p });
  if (!r.ok) {
    return { ok: false, items: [], page: p, total: 0, error: r.error, errorText: r.errorText };
  }
  // 列表接口的成功码是 `code:0`（**不是** error:0，斗鱼各端点字段不统一）
  const code = r.json.code;
  if (code !== undefined && Number(code) !== 0) {
    logWarn('[douyu] mixList 业务错误: ' + code);
    return { ok: false, items: [], page: p, total: 0, error: code, errorText: '列表获取失败(' + code + ')' };
  }
  const d = r.json.data;
  if (!d || typeof d !== 'object') {
    return { ok: false, items: [], page: p, total: 0, error: 'BAD_SHAPE', errorText: '列表数据缺失' };
  }
  const rl = Array.isArray(d.rl) ? d.rl : [];
  let items = normalizeRoomList(rl, { size: o.size });
  if (hideOffline) items = items.filter((x) => !x.offline);

  let total = Number(d.pgcnt) || 0;
  if (total > MAX_PAGES) total = MAX_PAGES;
  // 页码越界时服务端给 200 + 空 rl → 交给调用方（items 为空即到底）
  return { ok: true, items: items, page: p, total: total };
}

// 关键词匹配：标题或主播名包含（大小写不敏感；斗鱼标题多为中文，忽略大小写只为英文关键词）
export function matchKeyword(item, kw) {
  if (!item || !kw) return false;
  const k = String(kw).toLowerCase();
  return (
    String(item.title || '').toLowerCase().indexOf(k) >= 0 ||
    String(item.streamer || '').toLowerCase().indexOf(k) >= 0
  );
}

/**
 * 关键词搜索（getSearchRec 兜底：关键词 → 分类 cid2 → 该分类房间 → 本地过滤）。
 *
 * 返回 { ok, items, via, error?, errorText? }：
 *   via='direct' 本地过滤有命中（items 已按关键词筛过）
 *   via='cate'   关键词命中了分类，但该分类房间里没人把关键词写进标题/主播名
 *                → 返回该分类**全部**房间（用户意图多半就是想看这个分类）
 * @param {string} keyword
 * @param {{limit?: number, hideOffline?: boolean, size?: 'rs16'|'rs1'}} [opts]
 * @returns {Promise<{ok:boolean, items:Array, via:string, error?:*, errorText?:string}>}
 */
export async function searchLive(keyword, opts) {
  const o = opts || {};
  const kw = typeof keyword === 'string' ? keyword.trim() : '';
  if (!kw) return { ok: true, items: [], via: 'direct' };
  const limit = Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : PAGE_SIZE;
  const hideOffline = o.hideOffline !== false;

  // 1) 关键词 → 候选分类
  const cates = await fetchCateByKeyword(kw);
  if (!cates.length) {
    logWarn('[douyu] 搜索无候选分类: ' + kw);
    // 无候选分类 → 退化为在推荐流里过滤（覆盖「关键词直接出现在标题里但没对应分类」的情况）
    const r = await fetchLiveList(0, 1, { hideOffline: hideOffline, size: o.size });
    if (!r.ok) return { ok: false, items: [], via: 'direct', error: r.error, errorText: r.errorText };
    const hit = r.items.filter((x) => matchKeyword(x, kw)).slice(0, limit);
    return { ok: true, items: hit, via: 'direct' };
  }

  // 2) 逐个候选分类拉首页，本地过滤；第一个有命中的就返回
  const tried = Math.min(cates.length, SEARCH_MAX_CATE);
  let firstCateItems = null; // 兜底用的「分类全部房间」
  let lastErr = null;
  for (let i = 0; i < tried; i++) {
    const c = cates[i];
    const r = await fetchLiveList(c.cid2, 1, { hideOffline: hideOffline, size: o.size });
    if (!r.ok) {
      lastErr = r;
      continue;
    }
    if (!firstCateItems && r.items.length) firstCateItems = r.items;
    const hit = r.items.filter((x) => matchKeyword(x, kw));
    if (hit.length) {
      return { ok: true, items: hit.slice(0, limit), via: 'direct' };
    }
  }

  // 3) 没有任何标题命中 → 返回第一个非空分类的全部（标 via:'cate'）
  if (firstCateItems && firstCateItems.length) {
    return { ok: true, items: firstCateItems.slice(0, limit), via: 'cate' };
  }
  if (lastErr) {
    return { ok: false, items: [], via: 'cate', error: lastErr.error, errorText: lastErr.errorText };
  }
  return { ok: true, items: [], via: 'cate' };
}

/**
 * 取房间详情归一（给播放页用：列表 item + 可选大封面）。
 * 目前斗鱼没有轻量 room info 端点走这套（getH5Play 才是权威），
 * 这里只提供「从 rl[] 单条归一」的便捷封装，避免 UI 直接碰原始字段。
 * @param {object} raw
 * @param {'rs16'|'rs1'} [size]
 */
export function roomFromRaw(raw, size) {
  return normalizeRoom(raw, { size: size });
}
