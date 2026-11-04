// 播放会话编排（可注入、可取消；页面只消费稳定接口）
//
// 本客户端只播斗鱼直播（docs/pure-douyu-refactor.md）：
//   房间号（rid）→ douyu/api.js 签名取流（getEncryption → getH5PlayV1）
//   → player.open(按 FLV 宽高信箱适配的居中矩形 + UA/Referer)。
//   直播 FLV 自带音轨（input2 恒空、durationMs=0、不可 seek）。
// 控制：toggle / readStatus / closeSession / 换链（refreshLiveUrl），全部幂等、结构化错误。
//
// 硬解（v3.0.0 / X6 Pro）：native 侧从「ffmpeg 软解成 RGB 帧」改为「ffmpeg 只搬压缩包 +
// gst mppvideodec 硬解上屏」，所以 1080p60 也不再需要 JS 侧的像素预算。
/* 取流只在 resolveLiveUrl/refreshLiveUrl 内部用到；用静态 import 而不是动态 import()，
 * 因为 aiot-vue-cli 的打包对动态 import 支持不稳（QuickJS 侧也没有独立的 chunk 加载器）。
 * douyu/api.js 自身在 import 时不发请求，副作用为零。 */
import { fetchPlayInfo as douyuFetchPlayInfo, DEFAULT_RATE as DOUYU_DEFAULT_RATE } from './douyu/api.js';
import { playVideoRects, LIVE_VIDEO_AREA } from './screen.js';
import { liveFpsCapFor } from './video_settings.js';

/* 直播的渲染帧率基准（native open 的 fps 参数）。
 * 斗鱼服务端不给帧率字段，FLV 里的实际帧率由 videorate/fpsCap 封顶，这里只给一个
 * 基准值；与 native 直播管线的默认 30fps 对齐。 */
export const LIVE_FPS = 30;

export const SEEK_STEP_MS = 20000;

/* ===================== 直播直链 TTL / 主动换链 =====================
 *
 * 斗鱼（doc §1）：getH5PlayV1 给的 FLV 直链自带 `expire=300`（**5 分钟**），
 * 且签名里绑了 ts + auth —— 过期后 CDN 直接 401/403，改后缀或续 query 都会
 * 被签名校验拒掉（实测把 `_900` 改成 `_4000` 即 403）。唯一正确的续播方式是
 * 用 session.roomid **重新签名**再取一条新链（getEncryption → getH5PlayV1）。
 *
 * 为什么要在 JS 侧主动换而不是等 native 断了再说：native 的断流重连用的是
 * open 时下发的原 URL，5 分钟到点后它怎么重试都只会失败 → 用户看到「一直在
 * 重连」。JS 必须在直链死之前把新 URL 换进去（native 侧 setInput 或重开）。
 *
 * 为什么阈值是 210s 而不是贴着 300s：换链要走两次网络请求（getEncryption 可能
 * 命中缓存 + getH5PlayV1），笔端实测单次 300~900ms，叠加 Wi-Fi 抖动 / 换链
 * 失败后还要有一次重试窗口，留 90s 余量才安全。多换几次的成本只是一次 GET。
 * ========================================================================= */
export const LIVE_URL_TTL_MS = 300000; // 斗鱼直链 expire=300s
export const LIVE_URL_REFRESH_MS = 210000; // 提前 90s 换链

/**
 * 是否该给这个直播会话换一条新直链（纯函数，nowMs 由调用方喂，便于单测）。
 *
 * 三个条件缺一不可：
 *   - session.live === true：点播的直链带 deadline（约 2h）但换链没有意义
 *     本客户端只播直播，所以换链只对 live 会话生效。
 *   - liveUrlAt > 0：0 表示「不知道这条链是什么时候拿的」（老会话/恢复出来的
 *     会话没有这个字段）→ 不主动换，避免一开播就白换一条。
 *   - nowMs - liveUrlAt >= LIVE_URL_REFRESH_MS：到点换。
 *
 * @param {{live?: boolean, liveUrlAt?: number}} session
 * @param {number} nowMs 毫秒时间戳（单测喂假值）
 * @returns {boolean}
 */
export function shouldRefreshLiveUrl(session, nowMs) {
  if (!session || typeof session !== 'object') return false;
  if (session.live !== true) return false;
  const at = Number(session.liveUrlAt) || 0;
  if (!(at > 0)) return false;
  const now = Number(nowMs);
  if (!isFinite(now)) return false;
  return now - at >= LIVE_URL_REFRESH_MS;
}

/* ================= native 数值字段归一化（P0-1 防御性修复） =================
 *
 * 为什么必须有：native 的 status() 用**哨兵值**表达"还没测到"，最典型的是
 * videoStallMs 在"从未出过一帧"时返回 **-1**。旧代码写的是
 *     videoStallMs: Number(st.videoStallMs) || 0
 * 而 Number(-1) 是 -1（真值，|| 不会兜底）→ -1 原样透传到页面看门狗的
 * `videoStallMs > 8000` 判断，恒为 false → 看门狗永不触发 → 界面永久"加载中…"，
 * 用户只能杀进程。直链带 deadline（直播 FLV 的 expire=300s 是最短的一种）是最常见的踩中路径。
 *
 * 三个工具的分工（不要混用）：
 *   num(v, dflt)        —— 计数/位置/字节/时长：非 number、非有限数、负数 → dflt。
 *                          用于 frames/positionMs/audioBytes/videoStallMs 等"负数无意义"的量。
 *   numSigned(v, dflt)  —— 可为负的诊断量：只挡非 number 与非有限数，保留负数。
 *                          avDriftMs（音频位置−画面位置，负=声音滞后）、
 *                          audioBufMs（可闻锚修正量）、lastError（native 错误码本身可为负，
 *                          真机见过 -5/EIO）都属于这一类。
 *   numLatency(v)       —— 音画起播差：**-1 是"未测到"的有效语义**，必须原样保留，
 *                          页面用 `>= 0` 判断"是否测到了"。缺失时也返回 -1。
 * ========================================================================= */
export function num(v, dflt) {
  const d = typeof dflt === 'number' ? dflt : 0;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return isFinite(n) && n >= 0 ? n : d;
}

export function numSigned(v, dflt) {
  const d = typeof dflt === 'number' ? dflt : 0;
  if (typeof v === 'number') return isFinite(v) ? v : d;
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return isFinite(n) ? n : d;
}

export function numLatency(v) {
  if (typeof v === 'number') return isFinite(v) ? v : -1;
  if (v === null || v === undefined || v === '') return -1;
  const n = Number(v);
  return isFinite(n) ? n : -1;
}

/* native status().state 白名单。
 *
 * native 自己的枚举是 idle/opening/playing/paused/error/stopped（见
 * native/csrc/jsapi_player2.c 的 names[]），页面另有两个 UI 态 loading/seeking/ended。
 * 这里只放行这些已知值，其余（含拼错、native 将来新增未知态、返回对象/数组等）
 * 一律落到 'error' —— 让界面显示"可返回重试"，而不是停在一个谁都分支不到的状态上
 * 无限"加载中…"。
 *
 * 'stopped' 特殊处理：它是 native 对 stop() 之后的正常态（不是故障），归一到 'idle'，
 * 否则正常停止会被界面当成错误。 */
const KNOWN_STATES = {
  idle: 'idle',
  opening: 'opening',
  playing: 'playing',
  paused: 'paused',
  seeking: 'seeking',
  ended: 'ended',
  error: 'error',
  stopped: 'idle'
};

export function normalizeState(raw, ctx) {
  if (typeof raw === 'string' && KNOWN_STATES[raw] !== undefined) return KNOWN_STATES[raw];
  const shown = typeof raw === 'string' ? raw : raw === undefined ? 'undefined' : JSON.stringify(raw);
  if (ctx && ctx.log) {
    ctx.log('[douyu] 未识别的播放器状态 state=' + shown + ' → 按 error 处理（避免界面卡在未知态）');
  }
  return 'error';
}

/* ================= 直播终止判据（P1-4） =================
 *
 * 直播没有时长可用（durationMs=0），不能用「位置比时长」判末尾，必须换判据。
 *
 * 直播 EOS（主播下播）在 native 侧走的是：
 *   session.c 的 `BUS EOS` → `pb2_stats_patch_state(&g_w.stats, PB2_STATE_STOPPED)`
 * 而 jsapi_player2.c 的 state 白名单是 {idle, opening, playing, paused, error, stopped}
 * —— **没有 ended**；normalizeState 又把 `stopped` 归一成 `'idle'`（表示 stop() 的正常态）。
 * 三条叠加的结果：主播下播后 tick 拿到的 state 是 `'idle'`，页面原有的
 * `if (st.state === 'ended')` 分支永远进不去 → 界面停在「播放中」，进度条（直播位置
 * 就是墙钟秒数）还在继续走，用户只能自己返回。
 *
 * 所以这里用「live + state 落回 idle/ended」判终止，再用两个证据把
 * 「刚进页面还没起播」（state 也在 idle/opening，位置 0、没出过帧）排除掉：
 *   · everPlayed：本会话曾经出现过 playing（页面侧维护的历史事实）；
 *   · frames > 0：至少真的出过帧。
 * 只要有一条成立，就说明这场直播确实播起来过、现在停了 = 已结束。
 *
 * ★ **不能用 positionMs > 0 当证据**：直播位置 = 墙钟（native live_position_ms()），
 * 从 open 那一刻就开始走，一帧都没出也照样每秒 +1000。用它会在一进页面、native
 * 还没 patch 到 opening 的那一个 tick 上把「刚打开」误判成「已结束」。
 *
 * 注意：也**不要**用「位置不再增长」判 —— 同样是墙钟，EOS 之后管线还在、位置照样涨。 */
export function isLiveEnded(st, live, everPlayed) {
  if (live !== true) return false; // 只对直播生效
  if (!st || typeof st !== 'object') return false;
  /* state 只认 native 明确收回的两个值：
   *   idle  = STOPPED（EOS）经 normalizeState 归一后的结果；
   *   ended = 将来 native 真加了 PB2_STATE_ENDED 时的直通值。 */
  if (st.state !== 'idle' && st.state !== 'ended') return false;
  if (everPlayed === true) return true;
  /* 没观察到过 playing（轮询 1s 一次，主播刚下播就点进去时会漏）：
   * 用「出过帧」兜底，避免把「刚进页面还没起播」误判成已结束。 */
  return num(st.frames, 0) > 0;
}

/* ================= 直播重连提示（P1-4 的 JS 侧配套） =================
 *
 * native 直播走 souphttpsrc（timeout=15s、retries=3），最坏 45 秒里画面冻住而
 * state 仍是 playing —— 用户看不到任何反馈。native2 会在重连开始时
 * `pb2_stats_patch_error(&g_w.stats, PB2_E_LIVE_RECONNECT, "...")`，
 * 重连成功清零（**故意不改 state**，否则 readStatus 会走 ok:false 让页面判失败）。
 *
 * 这里只做「码 → 是否正在重连」的翻译。码值 17 与 native2 对齐
 * （core/queue.h 已占用 0..16，17 是下一个空位）。
 * 另留一条 lastErrorMsg 含 `reconnect` 的兜底：万一 native 最终换了码，提示仍能出来。
 */
export const LIVE_RECONNECT_ERR = 17;

export function isLiveReconnecting(st, live) {
  if (live !== true) return false;
  if (!st || typeof st !== 'object') return false;
  /* 真错误态（state === 'error'）交给页面原有的失败路径，不抢它的提示 */
  if (st.state === 'error') return false;
  if (numSigned(st.lastError, 0) === LIVE_RECONNECT_ERR) return true;
  const msg = typeof st.lastErrorMsg === 'string' ? st.lastErrorMsg : '';
  return /reconnect/i.test(msg);
}

/* 直播取流：房间号 → {ok, live:true, url, audioUrl:'', qn, roomid, durationMs:0,
 *          title, width, height, host, fps, site, liveUrlAt, douyuRate, rates}
 *          | {ok:false, stage, code?, message}
 *
 * 本客户端只播斗鱼（doc §1）：每次播放都重新签名取直链（getEncryption → getH5PlayV1，
 * 直链 expire=300s），不缓存、不做「服务器地址 + 解析缓存」。
 *
 * 【audioUrl 固定为空 —— 直播走单输入单管线】
 * v2（player2）的直播路径不经 ffmpeg：GStreamer 直连 `souphttpsrc ! flvdemux`（实测 45s 出
 * 3018 帧、零 error、真实 kmssink 上屏）。v1 时代之所以要「同一 URL 的独立进程」是因为
 * 单进程串行写两个输出会背压；现在没有第二个输出了。
 *
 * FLV 单流本身已含音轨，flvdemux 会同时给出 video/x-h264 与 audio/mpeg 两个 pad，
 * 音视频天然同容器同 interleave。**若这里回填 audioUrl=url，native 会按 MAP_DUAL_IN
 * 用同一个 URL 开第二条连接**（日志里 in= 与 in2= 完全相同），纯属浪费，还会让 native
 * 的「直播直连」判据失效。 */
export async function resolveLiveUrl(ctx, item) {
  return resolveDouyuLiveUrl(ctx, item);
}

/* ===================== 斗鱼直播（doc §1/§3） =====================
 *
 * 关键事实（每一条都是真机/联网实测，不是猜测）：
 *   - 直链 expire=**300s** → 换链必须**重新签名**（getEncryption +
 *     getH5PlayV1），改 URL 后缀/续 query 一律 403。
 *   - 服务端**不保证**遵守请求的 rate（实测 rate=4 可能回 rate=0，rate=0 可能回
 *     rate=4）→ 实际档位以返回值 `rate` 为准，UI 不要拿请求值显示。
 *   - 错误语义：-15 = 房间不存在/未开播；-9 = 设备时钟偏差；403 = auth/did 不一致。
 *   - 直链是 FLV + 音轨在同一条流里 → 仍然 audioUrl=''。
 *
 * 图片/列表字段全在 services/douyu/ 下，这里只负责「房间号 → 可播放直链」。
 * ========================================================================= */

// 会话里该播哪个斗鱼码率档：页面可用 ctx.douyuRate 覆盖（doc §3：2 默认，可选 4/3/0）
function douyuRateFor(ctx) {
  const v = Number(ctx && ctx.douyuRate);
  return isFinite(v) && v >= 0 ? v : DOUYU_DEFAULT_RATE;
}

// 统一取「现在」的毫秒时间戳：单测喂 ctx.nowMs，真机走 Date.now
function nowMsOf(ctx) {
  const n = ctx && typeof ctx.nowMs === 'function' ? Number(ctx.nowMs()) : NaN;
  return isFinite(n) && n > 0 ? n : Date.now();
}

/* 斗鱼取流 → resolveLiveUrl 的返回形状。
 * api.fetchPlayInfo 已经把 HTTP/业务码归一成 {ok,error,errorText}，这里再翻成
 * 播放层统一的 {ok:false,stage,message}（页面用 describePlayError 显示一行话）。 */
async function resolveDouyuLive(ctx, rid, rate) {
  // 可注入：单测/诊断时用 ctx.douyuFetchPlayInfo 替身（真机走 api.fetchPlayInfo）。
  // 与 ctx.client / ctx.player 的注入风格一致，避免单测真的打网络。
  const fetchPlay = ctx && typeof ctx.douyuFetchPlayInfo === 'function'
    ? ctx.douyuFetchPlayInfo
    : douyuFetchPlayInfo;
  const r = await fetchPlay(rid, rate);
  if (r && r.ok) {
    return {
      ok: true,
      url: r.url,
      rate: r.rate, // 服务端**实际**给的档位
      rates: r.rates || []
    };
  }
  const code = r ? r.error : 'NETWORK';
  // -15 = 房间不存在或未开播（实测 ol=0 的房间必得 -15）；其他都算取流失败
  if (code === -15) {
    return { ok: false, stage: 'offline', code: code, message: (r && r.errorText) || '主播未开播' };
  }
  return {
    ok: false,
    stage: 'playurl',
    code: code,
    message: (r && r.errorText) || '斗鱼取流失败'
  };
}

/* 斗鱼直播：房间号 → {ok, live:true, url, ...} | {ok:false, stage, message}
 * item 就是 services/douyu/normalize.js 的条目（site:'douyu', rid, title...）。 */
async function resolveDouyuLiveUrl(ctx, item) {
  const rid = Number(item && (item.rid || item.roomid)) || 0;
  if (!(rid > 0)) return { ok: false, stage: 'param', message: '房间号无效' };
  const rate = douyuRateFor(ctx);
  const r = await resolveDouyuLive(ctx, rid, rate);
  if (cancelled(ctx)) return { ok: false, stage: 'cancel', message: '已取消' };
  if (!r.ok) return r;
  return {
    ok: true,
    live: true,
    url: r.url,
    /* FLV 自带音轨：回填会开第二条连接（native MAP_DUAL_IN） */
    audioUrl: '',
    qn: r.rate,
    roomid: rid,
    durationMs: 0,
    title: (item && item.title) || '',
    /* getH5PlayV1 不返回分辨率（multirates 只有 name/rate/bit）→ 按 FLV 源常见的
     * 16:9 给默认值；信箱适配只影响上屏比例，不影响解码（native 硬缩放）。 */
    width: 1280,
    height: 720,
    host: '',
    fps: LIVE_FPS,
    site: 'douyu',
    liveUrlAt: nowMsOf(ctx),
    /* 换链时要记住**请求的**档位（不是服务端回的实际档位）：续播沿用用户选的档，
     * 服务端再次就近降/升档是它的自由。 */
    douyuRate: rate,
    rates: r.rates
  };
}

/* 直播直链过期前的**主动换链**（页面轮询：shouldRefreshLiveUrl(session, now) →
 * refreshLiveUrl(ctx, session)）。
 *
 * 为什么不能「改 URL 后缀」或「续 query」：斗鱼直链的 wsAuth/token/expire 都是
 * 服务端按 (did, rid, ts, auth) 签发的，改任何一个字符都过不了 CDN 校验（实测把
 * `_900.flv` 改成 `_4000.flv` 直接 403）。唯一合法途径是重新走一遍
 * getEncryption → getH5PlayV1（api.fetchPlayInfo 内部就是这两步）。
 *
 * 返回：
 *   {ok:true,  url, liveUrlAt, qn?, rates?, message:''}
 *   {ok:false, stage, message}           —— stage 与 resolveLiveUrl 同构，绝不 throw
 *
 * 调用方拿到新 url 后的动作（native 侧）不在本函数职责内：页面按自己的能力
 * 选择 player.openSession 重开或把新 URL 交给 native 的换源命令。
 *
 * @param {object} ctx     与 openVideo 同一个 ctx（需要其中任意一个；不读屏）
 * @param {{roomid?: number, rid?: number, site?: string, douyuRate?: number, live?: boolean}} session
 *        openVideo() 返回的 session；`live` 必须为 true 才会取流
 * @param {{nowMs?: number, rate?: number}} [opts] 单测可喂假 nowMs / 指定档位
 */
export async function refreshLiveUrl(ctx, session, opts) {
  const o = opts || {};
  if (!session || typeof session !== 'object') {
    return { ok: false, stage: 'param', message: '会话不存在' };
  }
  if (session.live !== true) {
    return { ok: false, stage: 'param', message: '不是直播会话' };
  }
  // 斗鱼的 roomid 就是 rid；两个字段都认，避免页面转述时丢字段。
  const roomid = Number(session.roomid || session.rid) || 0;
  if (!(roomid > 0)) return { ok: false, stage: 'param', message: '直播间号无效' };

  // 时钟：单测喂 opts.nowMs，其次 ctx.nowMs，最后 Date.now
  const nowMs = isFinite(Number(o.nowMs)) && Number(o.nowMs) > 0
    ? Number(o.nowMs)
    : nowMsOf(ctx);
  // 档位优先级：opts.rate → 会话里**请求过的**档位 → 默认档（doc §3：2 高清）
  const rate = isFinite(Number(o.rate)) && Number(o.rate) >= 0
    ? Number(o.rate)
    : (isFinite(Number(session.douyuRate)) && Number(session.douyuRate) >= 0
      ? Number(session.douyuRate)
      : DOUYU_DEFAULT_RATE);
  const r = await resolveDouyuLive(ctx, roomid, rate);
  if (cancelled(ctx)) return { ok: false, stage: 'cancel', message: '已取消' };
  if (!r.ok) return r;
  return {
    ok: true,
    url: r.url,
    liveUrlAt: nowMs,
    qn: r.rate,
    rates: r.rates || [],
    douyuRate: rate,
    message: ''
  };
}

function cancelled(ctx) {
  return !!(ctx.cancelled && ctx.cancelled());
}

// → {ok, session} | {ok:false, stage, message, code?} | {ok:false, stage:'cancel'}
export async function openVideo(ctx, item) {
  const rs = await resolveLiveUrl(ctx, item);
  if (!rs.ok) return rs;
  if (cancelled(ctx)) return { ok: false, stage: 'cancel', message: '已取消' };
  /* 矩形按 FLV 源真实宽高做信箱适配。直播没有进度条，视频区是 469x266
   * （LIVE_VIDEO_AREA）；这个矩形必须与 falcon 侧 hole 的几何严格一致
   * （见 base.less 的 .video-hole-live），否则会出现「画面与点击热区差 26px」的错位。 */
  const rects = playVideoRects(rs.width, rs.height, LIVE_VIDEO_AREA);
  /* 帧率上限（0 = 不限）：native 侧在 mppvideodec 之后插 videorate max-rate=N。
   * 斗鱼服务端不给帧率字段，只能靠 videorate 封顶；它只做上限、不插帧。 */
  const fpsCap = liveFpsCapFor(ctx.videoSettings);
  const openRes = await ctx.player.openSession({
    input: rs.url,
    /* 直播单流（FLV 自带音轨）：第二输入恒为空串，让 native 走「单输入直连」路径。 */
    input2: '',
    startMs: 0,
    durationMs: 0, // 直播：时长未知
    fps: fpsCap > 0 ? Math.min(rs.fps || LIVE_FPS, fpsCap) : (rs.fps || LIVE_FPS),
    audio: true,
    transpose: 2,
    rect: rects.physical,
    /* '' = 自动：已连蓝牙耳机走 bluealsa，否则内置扬声器（player.c 的 detect_bt_pcm） */
    audioDevice: '',
    userAgent: ctx.mediaUa,
    referer: ctx.mediaReferer,
    fpsCap: fpsCap,
    /*
     * 显式直播意图（native open 的第 16 个位置参数）。
     * 不靠 native 的「durationMs == 0 且是 http」猜：我们是明确知道意图的，直接告诉它。
     */
    isLive: true
  });
  if (!openRes || openRes.ok !== true) {
    return {
      ok: false,
      stage: 'open',
      code: openRes ? openRes.code : undefined,
      message: (openRes && (openRes.code + ': ' + openRes.error)) || '播放器启动失败'
    };
  }
  if (ctx.log) {
    ctx.log(
      '[douyu] open ok rid=' + (rs.roomid || 0) +
        ' out=' + openRes.outWidth + 'x' + openRes.outHeight +
        ' fps=' + openRes.fps +
        ' audio=' + (openRes.audioRate || '?') + (openRes.audioBt ? '(BT)' : '') +
        ' rate=' + rs.qn
    );
  }
  return {
    ok: true,
    session: {
      kind: 'live',
      live: true,
      rid: rs.roomid || 0,
      roomid: rs.roomid || 0,
      title: rs.title || item.title || '',
      up: item.up || item.streamer || '',
      desc: item.desc || '',
      cover: item.cover || '',
      /* qn = 服务端**实际**给的斗鱼档位（可能不等于请求值，见 douyu/api.js） */
      qn: rs.qn,
      durationMs: 0,
      outWidth: openRes.outWidth,
      outHeight: openRes.outHeight,
      /* 键盘避让恢复用：open 时下发给 native 的物理矩形（= open 参数里的 x/y/width/height）。
       * 注意坐标系：x 是「视频逻辑区左缘」，**不含**面板偏移 —— native 在
       * build_pipeline 与 PB2_CMD_SET_RECT 里都会统一加 PB2_PANEL_X_OFFSET(107)。
       * 所以这里原样回传给 setVideoRect 即可，不要在 JS 侧再加偏移（加了会变 214）。 */
      rectPhysical: rects.physical,
      /* 直播换链：页面轮询用 shouldRefreshLiveUrl(session, now) 判定、refreshLiveUrl()
       * 取新链。liveUrlAt 是这条直链的取得时刻。
       * douyuRate 是**请求的**斗鱼档位（换链沿用），rates 供「码率」菜单展示。 */
      liveUrlAt: rs.liveUrlAt || 0,
      site: 'douyu',
      douyuRate: rs.douyuRate,
      rates: rs.rates || []
    }
  };
}

// playing=true → 暂停；false → 继续 → {ok, state} | {ok:false, message}
export async function togglePlay(ctx, playing) {
  const r = playing ? await ctx.player.pause() : await ctx.player.resume();
  if (!r || r.ok === false) {
    const detail = r ? [r.code, r.error].filter(Boolean).join(': ') : '';
    return { ok: false, message: detail || '控制失败' };
  }
  return { ok: true, state: r.state };
}

// 原地自愈（任务 D）：优先 native recover()，不支持时返回 {ok:false, code:'PLAYER_UNSUPPORTED'}。
// 页面据此决定是"原地恢复一次"还是"只提示不动手"——绝不再用 stop+open 全量重启。
export async function recoverSession(ctx) {
  if (!ctx || !ctx.player || typeof ctx.player.recover !== 'function') {
    return { ok: false, code: 'PLAYER_UNSUPPORTED', message: '当前播放器实现不支持原地恢复' };
  }
  try {
    const r = await ctx.player.recover();
    if (!r || r.ok === false) {
      const detail = r ? [r.code, r.error].filter(Boolean).join(': ') : '';
      return { ok: false, code: (r && r.code) || 'PLAYER_RECOVER_FAILED', message: detail || '原地恢复失败' };
    }
    return { ok: true, state: r.state };
  } catch (e) {
    return { ok: false, code: 'PLAYER_RECOVER_FAILED', message: (e && e.message) || '原地恢复失败' };
  }
}

// → {ok, state, frames, positionMs, audioBytes, audioDropped, audioUnderruns, audioWrErrors, audioRingDrops}
// | {ok:false, state:'error', message}
// 音频卡顿定位证据链（v1.3.0 环形推送）：
//   ab 增速断+u=0+画面冻=ffmpeg供给断；rd>0=环满(BT持续慢)；u 持续涨=欠载等待；w=aplay写失败；ad=写错误丢字节
export async function readStatus(ctx) {
  const st = await ctx.player.status();
  const zero = {
    audioBytes: 0,
    audioDropped: 0,
    audioUnderruns: 0,
    audioWrErrors: 0,
    audioRingDrops: 0
  };
  if (!st || st.ok === false) {
    return Object.assign(
      { ok: false, state: 'error', message: (st && (st.error || st.code)) || '状态读取失败', frames: 0, positionMs: 0 },
      zero
    );
  }
  if (st.state === 'error') {
    return Object.assign(
      {
        ok: false,
        state: 'error',
        message: st.error || '播放错误',
        frames: st.frames || 0,
        positionMs: st.positionMs || 0
      },
      {
        audioBytes: Number(st.audioBytes) || 0,
        audioDropped: Number(st.audioDropped) || 0,
        audioUnderruns: Number(st.audioUnderruns) || 0,
        audioWrErrors: Number(st.audioWrErrors) || 0,
        audioRingDrops: Number(st.audioRingDrops) || 0,
        audioDead: !!st.audioDead
      }
    );
  }
  return {
    ok: true,
    state: normalizeState(st.state, ctx),
    frames: num(st.frames, 0),
    positionMs: num(st.positionMs, 0),
    audioBytes: num(st.audioBytes, 0),
    audioDropped: num(st.audioDropped, 0),
    audioUnderruns: num(st.audioUnderruns, 0),
    audioWrErrors: num(st.audioWrErrors, 0),
    audioRingDrops: num(st.audioRingDrops, 0),
    audioDead: !!st.audioDead,
    /* A/V 巡检（v1.7.1）：playing 态距最近帧的毫秒（>8000=视频停帧）；gateWaitMs=起播门时长；
     * gateActive=门进行中（此时巡检让位，防弱网首帧期被误判打断）。
     *
     * videoStallMs 必须过 num()：native 在"从未出过一帧"时返回哨兵 **-1**
     * （见 native/csrc/jsapi_player2.c 的 `long long stall = -1;` 与
     * `mk_int(ctx, "videoStallMs", stall, res);`），而 -1 是真值，
     * 旧写法 `Number(-1) || 0` 兜不住它 → -1 直通页面看门狗的
     * `videoStallMs > 8000`（恒 false）→ 看门狗彻底失效 → 界面永久"加载中…"。
     * 归一化后 -1 → 0，真正的停帧（>8000 的正数）照样透传。 */
    videoStallMs: num(st.videoStallMs, 0),
    gateWaitMs: num(st.gateWaitMs, 0),
    gateActive: !!st.gateActive,
    /* v3.5.1 起播时序：声音比画面首帧晚多少毫秒才开写（-1=未测到）。
     * 这是「音画载入不同时」的直接量化指标，用于验证定格门是否真的把两者对齐。
     * **-1 是有意义的**（页面用 `>= 0` 判断"是否已经测到"）→ 走 numLatency 保留负值。 */
    audioLateMs: numLatency(st.audioLateMs),
    /* v3.5.1：声音比「画面可见」（KMS 平面 ACTIVE）晚多少毫秒。这才是用户感知的
     * 音画不同步量；audioLateMs 含 gst 启动耗时，会虚高 ~1.2s。同样保留 -1 语义。 */
    audioLateVisibleMs: numLatency(st.audioLateVisibleMs),

    /* v1.8.0 音画对齐诊断：videoSkips=丢帧快进计数（追音频钟）；avDriftMs=可闻音频位置−画面位置
     * （正=声音超前，**负=声音滞后** → 必须保留负号，否则诊断瞎掉一半）
     * v1.9.0：audioBufMs=可闻锚修正量（aplay 管道+ALSA 缓冲，恒定即正常，也可能为负）
     * v1.9.3：videoRestarts=视频断流重启次数（>0=发生过 CDN 断流，表现为短暂追赶后恢复） */
    videoSkips: num(st.videoSkips, 0),
    avDriftMs: numSigned(st.avDriftMs, 0),
    audioBufMs: numSigned(st.audioBufMs, 0),
    videoRestarts: num(st.videoRestarts, 0),
    /* v2.1.0 音画同步分层：resyncing=视频流正在强制重同步（首帧未产出）→ 页面显示"加载中…"；
     * resyncCount=漂移触发的强制重同步次数；avDriftNowMs=native 侧最近漂移（诊断，可为负）；
     * resyncLeadMs=重同步前移量（诊断）。
     *
     * resyncing 的"字段缺失"必须读作 false（= 不存在重同步这回事）：老 native 没有这个
     * 字段时，页面看门狗的让位条件 `!st.resyncing` 会成立 → 看门狗照常工作。
     * 反过来若把缺失当 true，看门狗就永久裸奔了（P0-1 第 4 条）。 */
    resyncing: st.resyncing === true,
    resyncCount: num(st.resyncCount, 0),
    avDriftNowMs: numSigned(st.avDriftNowMs, 0),
    resyncLeadMs: numSigned(st.resyncLeadMs, 0),
    /* v2.2.4：本次重同步已持续毫秒（未重同步为 0）——页面据此只在"恢复确实慢"时才弹「加载中」 */
    resyncingMs: num(st.resyncingMs, 0),

    /* ---- player2 新字段透传（缺失一律给安全默认值，v1 下恒为默认值）----
     * planeActive：KMS 显示平面是否 ACTIVE（false = 画面没在屏上）。
     * pipelineAlive：native 管线进程是否存活（false = 需要 recover/open）。
     * durationMs/fps/hasAudio：native 侧实测值（页面可用它校正 session 里的估算）。 */
    planeActive: st.planeActive === undefined ? true : !!st.planeActive,
    pipelineAlive: st.pipelineAlive === undefined ? true : !!st.pipelineAlive,
    nativeDurationMs: num(st.durationMs, 0),
    /* durationMs：native 侧时长的**同名别名**（n10）。
     * 起因：页面 tryRecover() 写的是 `Number(st && st.durationMs) || 0`，而这里只导出
     * nativeDurationMs → 取到 undefined → 恒 0。直播下两者恒为 0（时长未知），
     * 保留同值别名是为了不破坏既有调用点。 */
    durationMs: num(st.durationMs, 0),
    nativeFps: num(st.fps, 0),
    hasAudio: st.hasAudio === undefined ? true : !!st.hasAudio,
    /* lastError 是 native 的 errno，真机见过 -5（EIO）→ 走 numSigned 保留负号 */
    lastError: numSigned(st.lastError, 0),
    lastErrorMsg: typeof st.lastErrorMsg === 'string' ? st.lastErrorMsg : '',
    /* muted/mutedBy：全局静音开关（player2 新增）。老 native 没有该字段 → 按"未静音"
     * 处理，不能因为字段缺失就在界面上给人打一个「已静音」角标。 */
    muted: st.muted === true,
    mutedBy: typeof st.mutedBy === 'string' ? st.mutedBy : '',
    /* screenOff：屏幕是否真的黑了（player2 读 /sys/class/backlight/*\/bl_power 判定，
     * 比 brightness JSAPI 的 getScreenState() 可靠 —— 后者把"调暗 DIM=3"也算非亮屏）。
     * 三态：true=熄屏/背光断电、false=亮、null=旧 native 没有该字段（页面回退到 JSAPI）。 */
    screenOff: st.screenOff === undefined ? null : !!st.screenOff
  };
}

// 幂等停止 + 释放 fb（stop/release 自身幂等）
export async function closeSession(ctx) {
  try {
    await ctx.player.stop();
    await ctx.player.release();
  } catch (e) {
    if (ctx.log) ctx.log('[douyu] closeSession 异常: ' + (e && e.message));
  }
  return { ok: true };
}

// 错误码/阶段 → 用户一行话
export function describePlayError(res) {
  if (!res || res.ok) return '';
  if (res.stage === 'cancel') return '';
  // 直播未开播：接口明确给了 -15（房间不存在/未开播），直接给用户一行话
  if (res.stage === 'offline') return res.message || '主播未开播';
  const stageText = {
    param: '参数错误',
    playurl: '取流失败',
    transport: '网络失败',
    http: 'HTTP ' + (res.status || ''),
    parse: '响应解析失败',
    open: '播放器启动失败'
  }[res.stage] || '失败';
  return stageText + (res.message ? '：' + res.message : '');
}
