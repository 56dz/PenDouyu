// 斗鱼分类树 + 关键词→分类映射（feed.js 的分类 tab 与搜索兜底共用）。
//
// 实测（2026-11-04，本机 node fetch 同 UA/Referer）：
//   getLeftNav → data.cateList[] = 5 个一级：
//     {id, stn1, cn1, relId, isCate1, list:[{cid2, cn2, stn2, url, cid1}]}
//   一级 5 个 / 二级共 55 个：
//     4 网游竞技(18) / 5 单机热游(9) / 6 手游休闲(18) / 20 娱乐(9) / 12 正能量(1)
//   ⚠️ 关键坑：subs 里的 `cid1` 取值是 {4,5,6,20,12}（= 一级 id，不是恒为 2），
//      而**拉房间列表时路径里的 cid1 恒为 2**（doc §1：「cid1 恒为 2，不是分类树里的 cid1」）。
//      → 所以 subs 里保留原始 cid1 仅作展示/回查，拼 mixList URL 时**必须写死 2**。
//
//   getSearchRec?kw=xx → data.cateResult[{cid, name, shortName, icon, kw, showNum}]
//      cid 就是可在 mixList/2_{cid} 用的 cid2（实测「王者」→ 181/3785/1056，181 是王者荣耀）。
//      第三个字段 showNum 是估算房间数，可用于排序/提示。
import { logWarn } from '../storage.js';
import { douyuGetJson, DOUYU_HOST } from './api.js';

export const CATEGORIES_PATH = '/wgapi/live/liveweb/getLeftNav';
export const SEARCH_REC_PATH = '/japi/search/api/getSearchRec';

// 分区列表 URL 的 cid1 **恒为 2**（doc §1；分类树里的 cid1 不能用于此路径）
export const MIX_CID1 = 2;

/**
 * 分类树归一：[{id, name, subs:[{cid1, cid2, name}]}]
 * @param {object} raw getLeftNav 的 data
 * @returns {Array}
 */
export function normalizeCategories(raw) {
  const list = raw && Array.isArray(raw.cateList) ? raw.cateList : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || typeof c !== 'object') continue;
    const subs = [];
    const sl = Array.isArray(c.list) ? c.list : [];
    for (let j = 0; j < sl.length; j++) {
      const s = sl[j];
      if (!s || typeof s !== 'object') continue;
      const cid2 = Number(s.cid2);
      if (!isFinite(cid2)) continue;
      subs.push({
        cid1: Number(s.cid1) || 0, // 仅展示用；拼 URL 请用 MIX_CID1
        cid2: cid2,
        name: typeof s.cn2 === 'string' && s.cn2 ? s.cn2 : ('分类' + cid2)
      });
    }
    if (!subs.length) continue; // 空分类没有可刷的房间，直接剔除
    out.push({
      id: Number(c.id) || 0,
      name: typeof c.cn1 === 'string' && c.cn1 ? c.cn1 : '未命名',
      subs: subs
    });
  }
  return out;
}

/**
 * 拉分类树。失败返回空数组（不 throw）。
 * @returns {Promise<Array>}
 */
export async function fetchCategories() {
  const r = await douyuGetJson(DOUYU_HOST + CATEGORIES_PATH, { tag: 'getLeftNav' });
  if (!r.ok) return [];
  if (Number(r.json.error) !== 0) {
    logWarn('[douyu] getLeftNav 业务错误: ' + r.json.error);
    return [];
  }
  return normalizeCategories(r.json.data);
}

/**
 * 关键词 → 候选分类（cid2 + 估算房间数 showNum，按 showNum 降序）。
 * 搜索兜底的第一步：先看关键词能命中哪些分类。
 *
 * 实测该端点偶发**传输层**失败（同机连续请求 6 次全 200，但在整轮压测后被拒过一次），
 * 所以传输/HTTP 失败重试一次（空结果不重试 —— 那是正常的「没有对应分类」）。
 * @param {string} kw
 * @returns {Promise<Array<{cid2:number, name:string, shortName:string, showNum:number}>>}
 */
export async function fetchCateByKeyword(kw) {
  const k = typeof kw === 'string' ? kw.trim() : '';
  if (!k) return [];
  const url = DOUYU_HOST + SEARCH_REC_PATH + '?kw=' + encodeURIComponent(k);
  let r = await douyuGetJson(url, { tag: 'getSearchRec' });
  if (!r.ok) {
    // 一次重试（网络抖动/风控瞬时拒绝）；仍失败就按「无候选分类」处理，由 searchLive 兜底
    r = await douyuGetJson(url, { tag: 'getSearchRec retry' });
    if (!r.ok) return [];
  }
  // `error:1` = 搜索被风控/限流瞬时拒绝（实测同一台机器连打 6 次全 0，压测后偶发 1 次 1）。
  // 它不是「这个词没有分类」，所以**也重试一次**；否则搜索会随机退化成空结果。
  if (Number(r.json.error) === 1) {
    logWarn('[douyu] getSearchRec 风控(1)，重试一次');
    r = await douyuGetJson(url, { tag: 'getSearchRec retry(risk)' });
    if (!r.ok) return [];
  }
  if (Number(r.json.error) !== 0) {
    logWarn('[douyu] getSearchRec 业务错误: ' + r.json.error);
    return [];
  }
  const d = r.json.data || {};
  const cr = Array.isArray(d.cateResult) ? d.cateResult : [];
  const out = [];
  for (let i = 0; i < cr.length; i++) {
    const c = cr[i];
    if (!c || typeof c !== 'object') continue;
    const cid = Number(c.cid);
    if (!isFinite(cid) || cid <= 0) continue;
    out.push({
      cid2: cid,
      name: typeof c.name === 'string' ? c.name : ('分类' + cid),
      shortName: typeof c.shortName === 'string' ? c.shortName : '',
      showNum: Number(c.showNum) || 0
    });
  }
  // 房间多的分类更可能命中关键词 → 优先试
  out.sort((a, b) => b.showNum - a.showNum);
  return out;
}
