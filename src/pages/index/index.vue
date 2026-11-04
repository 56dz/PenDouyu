<template>
  <!-- page-live 只在「视频像素真的在 fb 上」时启用透明背景（见 base.less 注释）；
       未起播/起播失败/已播完时必须用不透明底色，否则会把上一屏的 fb 残留像素透出来。 -->
  <div :class="holeVisible ? 'page page-live' : 'page'">
    <!-- 浏览态左栏：斗鱼一级分类（推荐 + fetchCategories 的 5 个一级）。
         纯斗鱼版没有站点切换 —— 左栏只有这一套标签，切站点那两格已随 B 站一起移除。 -->
    <div v-if="mode === 'browse'" class="bar">
      <div class="bar-head">
        <!-- 软件 logo：斗鱼官方鲨鱼图标（tools/make_douyu_icon.py 从同一张源图生成，
             与 app_icon.png 同源）。原 PenBili 的粉色 B 站电视 logo 已随 B 站一起删除。 -->
        <image class="bar-logo bar-logo-h" :src="ic.logo" :width="30" :height="30"></image>
      </div>
      <!-- 斗鱼一级分类（推荐=dyTop 0）。6 个标签 + 头部 30px，仍在 266px 内 -->
      <div
        v-for="c in dyTopTabs"
        :key="'dyt' + c.id"
        :class="dyTop === c.id ? 'dy-tab dy-tab-on' : 'dy-tab'"
        @click="selectDyTop(c.id)"
      >
        <text :class="dyTop === c.id ? 'dy-tab-text dy-tab-text-on' : 'dy-tab-text'">{{ c.label }}</text>
      </div>
      <text class="bar-status">{{ dyStatus }}</text>
    </div>

    <!-- 播放态左列：上=房间标题/热度/已播/码率(192)，下=码率四档按钮(74) -->
    <div v-if="mode === 'play'" class="pleft">
      <div class="pleft-info">
        <div class="pback" @click="onBack">
          <image class="pback-icon" :src="ic.back" :width="22" :height="22"></image>
        </div>
        <text class="ptitle">{{ infoTitle }}</text>
        <text class="pup">{{ pupText }}</text>
        <!-- 直播没有简介（session.desc 为空），这块 72px 换成实时信息三行。
             为什么不另起一行加高度：.pleft-info 是 192px 固定预算（26 返回 + 34 标题
             + 14 主播 + 72 简介 + 16 提示 + 上下留白），随便加一行就会把末尾的
             .pnote（重连中/加载中提示）挤出可视区。 -->
        <div class="pdesc dy-meta">
          <text class="dy-meta-row">热度 {{ dyOnlineText || '—' }}</text>
          <text class="dy-meta-row">已播 {{ liveElapsedText }}</text>
          <text class="dy-meta-row">当前 {{ dyRateLabel }}</text>
        </div>
        <!-- 播放提示（「加载中…」「直播重连中…」等）。
             为什么要单独一行：这些 note 只赋值给 this.play.note，需要模板渲染出来。
             而 .pvideo 里是 <hole>（透明挖孔，让 KMS 视频平面透出来），不能把文字塞进
             hole 里 —— hole 的职责就是"这里什么都没有"。
             这一行**恒定渲染**（无提示时是空串），不改几何尺寸，避免提示出现/消失时布局抖动。 -->
        <text class="pnote">{{ play.note }}</text>
      </div>
      <!-- 码率四档（2×2）。高度预算 192+74 不变。
           高亮判据用 session.qn（服务端就近取档，请求「原画」可能给「蓝光」），
           不用 dyRate（请求值），否则按钮会骗人。 -->
      <div class="pleft-btns dy-rate-row">
        <div
          v-for="o in dyRateOptions"
          :key="'dyr' + o.rate"
          :class="play.session && play.session.qn === o.rate ? 'dy-rate dy-rate-on' : 'dy-rate'"
          @click="onSwitchDyRate(o.rate)"
        >
          <text :class="play.session && play.session.qn === o.rate ? 'dy-rate-text dy-rate-text-on' : 'dy-rate-text'">{{ o.name }}</text>
        </div>
      </div>
    </div>

    <!-- 浏览内容（纯斗鱼：搜索行 + 二级分类横排 + 卡片网格 + 底部按钮） -->
    <div v-if="mode === 'browse'" class="content">
      <scroller class="list">
        <!-- 紧凑搜索行（26px，压在二级分类之上）。
             为什么只有 26px：内容区总共 250px，搜索行 26 + 二级分类 28 之后网格仍可滚，
             不算挤压。
             为什么整条 kw 区都可点：笔的触摸精度有限，26px 高的按钮太窄，
             点整行都拉起输入法最省操作；右侧按钮专管「搜索 / 返回」，语义更清楚。
             搜索态下二级分类行隐藏 —— 搜索结果是跨分类的，留着分类条会让人以为还能按类筛。 -->
        <div class="dy-search">
          <div class="dy-search-kw" @click="onOpenDyInput">
            <text class="dy-search-kw-text">{{ dySearchHint }}</text>
          </div>
          <div class="dy-search-btn" @click="onDySearchBtn">
            <text class="dy-search-btn-text">{{ dySearching ? '返回' : '搜索' }}</text>
          </div>
        </div>
        <!-- 二级分类横排：只有在一级分类下才有意义（推荐一级的 sub 为空，横排只显示一个「推荐」）。
             斗鱼一级分类最多挂 18 个二级（网游竞技/手游休闲），864px 一行放不下 18×96，
             所以这里用能换行的 .dy-chips。 -->
        <div v-if="!dySearching && dyChips.length > 1" class="dy-chips">
          <div
            v-for="c in dyChips"
            :key="'dyc' + c.cid2"
            :class="dyCid2 === c.cid2 ? 'dy-chip dy-chip-on' : 'dy-chip'"
            @click="selectDyCate(c.cid2)"
          >
            <text :class="dyCid2 === c.cid2 ? 'dy-chip-text dy-chip-text-on' : 'dy-chip-text'">{{ c.name }}</text>
          </div>
        </div>
        <div class="grid">
          <!-- 卡片：封面（166x93，网格 5 列由 GRID_COLS 决定）+「直播中」橙标
               + 热度 + 标题 + 主播名。
               ⚠ 角标为什么在封面**下方一条 12px 的横排**、而不是压封面上：
               falcon 的 position:absolute 不可靠（base.less 既有踩坑注释），
               压图只能靠负 margin 硬推，真机上不同机型会飘 —— 而这里没有真机可验，
               压歪比不压更难看。改成封面下方一条「直播中 ·……·  热度」的横条，
               视觉上仍贴着封面、零风险。多出的 12px 由 scroller 吸收（列表本来就可滚）。
               key 必须用 rid（斗鱼的唯一房间标识；它没有可深链的稿件号）。
               数据源用 computed dyViewItems（搜索态→dySearchItems，浏览态→dyItems），
               卡片结构两种状态**完全共用**这一段，不复制粘贴第二份 —— 两份以后必然改歪。 -->
          <div v-for="it in dyViewItems" :key="'dy' + it.rid" class="vrow" @click="onPlayDouyu(it)">
            <div class="dy-cell">
              <image class="thumb" :src="it.cover" :width="166" :height="93"></image>
              <div class="dy-tagrow">
                <text class="dy-live">直播中</text>
                <div class="dy-tagspacer"></div>
                <text class="dy-hot">{{ it.onlineText }}</text>
              </div>
            </div>
            <div class="vinfo">
              <text class="vtitle">{{ it.title }}</text>
              <text class="vmeta">{{ dyMeta(it) }}</text>
            </div>
          </div>
        </div>
        <!-- 底部两个按钮的语义按状态分叉：
             浏览态 = 刷新本分类 / 加载更多；
             搜索态 = 返回分类浏览 / 「没有更多了」（searchLive 无翻页参数，右侧只是状态提示、
             不挂 @click，放个假按钮会让人反复点）。重搜的入口是搜索行本身：点 kw 区会带出
             dyKeyword 预填。 -->
        <div v-if="!dySearching && dyItems.length" class="more-row">
          <div class="more-half" @click="selectDyCate(dyCid2)">
            <text class="more-text">刷新</text>
          </div>
          <div class="more-half" @click="loadMoreDy">
            <text class="more-text">{{ dyNoMore ? '没有更多了' : '加载更多' }}</text>
          </div>
        </div>
        <div v-if="dySearching && dySearchItems.length" class="more-row">
          <div class="more-half" @click="onExitDySearch">
            <text class="more-text">返回分类浏览</text>
          </div>
          <div class="more-half">
            <text class="more-text">没有更多了</text>
          </div>
        </div>
        <div v-if="!dyViewItems.length && !dyViewLoading" class="empty">
          <text class="empty-text">{{ dyStatus || (dySearching ? '没有搜到直播间 · 换个词试试' : '暂无直播 · 点左侧分类可重试') }}</text>
        </div>
      </scroller>
    </div>

    <!-- 播放态中列：视频 469x266（直播没有进度条，视频区撑满整列，见 base.less .pvideo-live）。
         注意 KMS 平面是硬件 overlay，尺寸由 native 的 render-rectangle 决定，
         这里的 class 只管 falcon 侧「挖孔」占位（hole）的几何 —— 两者必须一致，
         否则点击热区与画面对不上。 -->
    <div v-if="mode === 'play'" class="pmid">
      <div :class="isLivePlay ? 'pvideo pvideo-live' : 'pvideo'" @click="onTogglePlay">
        <!-- 点击视频区暂停/继续。
             hole 是视频平面上的透明占位，必须**自己**也绑 click —— falcon 的点击
             不一定从子节点冒泡到父容器，真机实测只绑父级会有一半面积点不动。 -->
        <hole v-if="holeVisible" :class="isLivePlay ? 'video-hole video-hole-live' : 'video-hole'" @click="onTogglePlay"></hole>
        <div v-else :class="isLivePlay ? 'play-idle play-idle-live' : 'play-idle'" @click="onTogglePlay">
          <text class="play-idle-text">{{ play.note || idleText }}</text>
        </div>
      </div>
      <!-- 直播态不渲染进度条：直播无时长、FLV 长连接不能拖。
           为什么不在这个 26px 位置改放「已播时长」文字：直播的 KMS 视频平面是
           469x266 撑满整列的硬件 overlay（screen.js 的 LIVE_VIDEO_AREA，高 266），
           它盖在 Falcon UI **之上** —— 在这里画的任何 DOM 用户都看不见。
           所以「已播时长」放左列信息卡里的 .dy-meta 三行（热度 / 已播 / 当前码率），
           那里不在视频平面上，用户能看见。 -->
    </div>

    <!-- 右列占位（必须保留，别删）。
         为什么不能只删：holeVisible 为真时根节点套 .page-live（背景透明，让 KMS 视频
         平面透出来 —— 见 base.less 顶部关于 2026-09-24 闪烁的注释）。.pleft 和 .pvideo
         都有自己的不透明底色，但右列 278px 原本靠 .pright 的 @nav-background 遮住。
         纯斗鱼版整列都没有内容，这 278px 就没有任何不透明元素兜底，会把上一屏的 fb 残留
         像素透出来（列表的封面等），看起来像"右侧半屏花了"。
         所以播放态放一个同宽同高、同底色的空占位。 -->
    <div v-if="isLivePlay" class="pright-fill"></div>
  </div>
</template>

<script>
import { GRID_COLS, trimToGridRows, KEEP_INTERVAL_MS, keepScreenOn, keepScreenOff, keepScreenBackend, keepScreenTicks, isKeepingScreen, getScreenState } from '../../services/screen.js';
/* 图标：assets/icons/ 下只剩 logo（左栏 30x30）与 back（播放页返回 22x22）。
 * 纯斗鱼版没有点赞投币、没有评论区、没有图文，其余 14 个图标文件已随 B 站一起删除。
 * logo 由 tools/make_douyu_icon.py 从斗鱼官方鲨鱼图生成，与 app_icon.png 同源。 */
import icBack from '../../assets/icons/back.png';
import icLogo from '../../assets/icons/logo.png';
import { KEYS, getJson, logWarn } from '../../services/storage.js';
import { isAutotestSeedEnabled, readAutotestSeed } from '../../services/autotest_seed.js';
import { runLiveEndCases } from '../../services/live_end_probe.js';
import { input } from '../../services/input.js';
/* play_session 的斗鱼分支（item.site==='douyu' → resolveDouyuLiveUrl）承担了
 * 取流、矩形计算（LIVE_VIDEO_AREA）、fpsCap、isLive 标记与 liveUrlAt 透传，
 * 页面这边不需要再自己拼 player.openSession（只有换链重开是例外，见 refreshDouyuLive）。
 * seek 相关导出已随点播一起删除，这里刻意不再引用。 */
import {
  openVideo,
  togglePlay,
  recoverSession,
  readStatus,
  closeSession,
  describePlayError,
  isLiveEnded,
  isLiveReconnecting,
  refreshLiveUrl
} from '../../services/play_session.js';
import * as player from '../../services/player.js';
import { DEFAULT_VIDEO_SETTINGS, loadVideoSettings } from '../../services/video_settings.js';
import { fetchCategories } from '../../services/douyu/cate.js';
import { fetchLiveList, searchLive } from '../../services/douyu/feed.js';
import { DEFAULT_RATE as DOUYU_DEFAULT_RATE, DOUYU_UA, DOUYU_REFERER } from '../../services/douyu/api.js';

/* 时间格式：沿用 PenBili 的「点播进度」口径（0 秒返回空串）。
 *
 * 原实现在 services/feed.js（B 站列表模块）里，随 B 站一起删除了；
 * 页面只有直播一个用途，且不能在 services 域新建文件（那是 services-dev 的写域），
 * 所以内联这 6 行。注意 formatDuration(0) 返回空串是刻意行为：
 * 点播场景里 "0 秒时长" 该显示"没有"，而直播刚开播的空状态由调用方补 '00:00'。 */
function formatDuration(sec) {
  const n = Math.floor(Number(sec) || 0);
  if (n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const p2 = (x) => (x < 10 ? '0' + x : String(x));
  return h > 0 ? h + ':' + p2(m) + ':' + p2(s) : p2(m) + ':' + p2(s);
}

function idlePlay() {
  return { state: 'idle', session: null, positionMs: 0, frames: 0, note: '' };
}

const STATE_LABELS = {
  idle: '',
  loading: '取流中…',
  playing: '播放中',
  paused: '已暂停',
  ended: '已播完',
  error: '出错'
};

/* 自愈看门狗参数（沿用 PenBili 真机结论，不要随手调小）。
 *
 * WATCHDOG_COOLDOWN_MS=60000：两次自愈之间至少隔 1 分钟。直播弱网下视频停帧是
 *   常态，短冷却会让看门狗连环触发，每次都往管线里塞一次恢复动作，反而把它拖死。
 * WATCHDOG_MAX_RECOVER=3：每个播放会话最多自愈 3 次，用尽后只给提示让用户返回重进，
 *   比"永远在重启中"的体验好得多。 */
const WATCHDOG_COOLDOWN_MS = 60000;
const WATCHDOG_MAX_RECOVER = 3;

/* 「无首帧」判失败阈值（必须有，别删）。
 *
 * 两个 stall 看门狗都建立在「videoStallMs 会增长」之上，但 videoStallMs 只在
 * "出过帧之后"才有意义：一帧都没出时 native 返回哨兵 -1（readStatus 已归一化成 0），
 * 0 > 8000 恒 false → 看门狗永不触发，界面永久停在「加载中…」，用户只能杀进程。
 * 斗鱼直播最现实的失败路径正好是这一类：取流成功但 CDN 侧一直不给数据。
 *
 * 15s 的依据：真机弱网起播门最坏 8~12s 才出首帧（音频先放行），15s 既留余量，
 * 又不至于让用户盯着「加载中」超过十五秒还不知道发生了什么。 */
const NO_FRAME_FAIL_MS = 15000;

/* 直播重连提示文案：tick 里有两处要跟它比对（该挂了吗 / 该撤了吗），
 * 写两遍字符串迟早拼错。 */
const LIVE_RECONNECT_NOTE = '直播重连中…';

/* ===== 斗鱼直播专用常量 =====
 * 码率（rate）是斗鱼专有档位。
 *   rate 0 = 原画（最高，可能 1080p+，弱网易卡）
 *   rate 4 = 蓝光4M
 *   rate 3 = 超清
 *   rate 2 = 高清 900kbps（默认：真机实测最稳，起播最快）
 * 服务端会「就近取档」，所以回显必须用 session.qn（见 dyRateLabel）。 */
const DY_RATE_OPTIONS = [
  { rate: 0, name: '原画' },
  { rate: 4, name: '蓝光4M' },
  { rate: 3, name: '超清' },
  { rate: 2, name: '高清' }
];

// rate → 中文档位名（未知档位回退成 rate 数字串，别静默显示空白）
function dyRateName(rate) {
  const r = Number(rate);
  for (let i = 0; i < DY_RATE_OPTIONS.length; i++) {
    if (DY_RATE_OPTIONS[i].rate === r) return DY_RATE_OPTIONS[i].name;
  }
  return isNaN(r) ? '高清' : 'rate ' + r;
}

/* 斗鱼直链是「一次性」的：同一条 URL 第二次 GET 必然 0.8s 内 EOF（约 423KB），
 * 所以 native 侧「用原 URL 重连」必定失败 —— 必须重新签名换链。
 * play_session.js 的 refreshLiveUrl(ctx, session) 会重新调 fetchPlayInfo 签名，
 * 并把新 url/liveUrlAt/qn 写回（注意不是给 URL 加后缀，加后缀会 403）。
 * 这里只负责「什么时候换」：errcode=17 重连中，或者链接快过期（expire=300s）。
 * 210s 与 play_session 的 LIVE_URL_REFRESH_MS 同一口径（提前 90s 换链）。 */
const DY_URL_REFRESH_MS = 210000;

export default {
  name: 'PageDouyu',
  data() {
    return {
      /* 斗鱼一级分类（网游竞技/单机热游/手游休闲/娱乐/正能量） */
      dyCates: [],
      // 当前一级分类 id（0 = 推荐，不走分类）
      dyTop: 0,
      // 当前二级分类 cid2（0 = 推荐，对应 mixList 的 0_0 段）
      dyCid2: 0,
      dyItems: [],
      dyPage: 1,
      dyTotal: 0,
      dyNoMore: false,
      dyLoading: false,
      dyStatus: '',
      /* 码率：页面记「用户请求的档位」，展示一律用 session.qn（服务端就近取档）。
       * 默认 2（高清 900kbps）—— 真机实测起播最快、弱网最稳，用户主动要清晰度再往上调。 */
      dyRate: DOUYU_DEFAULT_RATE,
      // 当前播放的房间条目（normalizeRoom 的产物：rid/title/streamer/cover/onlineText/…）
      dyPlaying: null,
      // 「已播时长」的起点（ms）与 tick 每秒推进的秒数（Date.now 非响应式，见 liveElapsedText）
      dyStartedAt: 0,
      dyElapsedSec: 0,
      /* 搜索态（与浏览态数据完全隔离：搜索跨分类，不能污染 dyItems） */
      dyKeyword: '',
      dySearching: false,
      dySearchItems: [],
      dySearchNoMore: false,
      dySearchPage: 1,
      dySearchLoading: false,
      /* mode：browse = 列表（左栏分类 + 网格）/ play = 播放页（左列信息 + 中列视频 + 右列兜底） */
      mode: 'browse',
      play: idlePlay(),
      /* 直播参数字：play_session 的 liveFpsCapFor(ctx.videoSettings) 要读它。
       * 纯斗鱼版没有「我的 → 视频调节」页面，这里只保留读盘取值（用户此前调过的
       * 档位仍然生效），不再提供 UI 修改入口。 */
      videoSettings: DEFAULT_VIDEO_SETTINGS
    };
  },
  computed: {
    /* ===== 斗鱼视图模型 ===== */
    /* 当前播放会话是不是斗鱼直播。session.site 由 play_session.js 的
     * resolveDouyuLiveUrl 原样透传（openVideo 把 liveUrlAt/site/douyuRate/rates
     * 一并放进 session），所以只需比对 site，不必再猜。 */
    isDouyuPlay() {
      return this.mode === 'play' && !!(this.play.session && this.play.session.site === 'douyu');
    },
    // 当前选中的一级分类对象（dyTop=0 时没有）
    dyTopCate() {
      for (let i = 0; i < this.dyCates.length; i++) {
        if (this.dyCates[i].id === this.dyTop) return this.dyCates[i];
      }
      return null;
    },
    /* 二级分类横排：推荐(cid2=0) + 当前一级分类下的二级分类。
     * 斗鱼分类树是一级 5 个 / 二级 55 个，一个横排塞不下 55 个，
     * 所以左栏竖排选一级、内容区顶部横排选二级（两段式，别混成一个列表）。 */
    dyChips() {
      const out = [{ cid2: 0, name: '推荐' }];
      const top = this.dyTopCate;
      const subs = top && top.subs ? top.subs : [];
      for (let i = 0; i < subs.length; i++) {
        out.push({ cid2: subs[i].cid2, name: subs[i].name });
      }
      return out;
    },
    /* 左栏一级分类竖排：推荐(id=0) + fetchCategories 的 5 个一级。
     * id=0 是「推荐」，走 mixList 的 0_0 段（不带分类），没有二级横排。 */
    dyTopTabs() {
      const out = [{ id: 0, label: '推荐' }];
      for (let i = 0; i < this.dyCates.length; i++) {
        out.push({ id: this.dyCates[i].id, label: this.dyCates[i].name });
      }
      return out;
    },
    /* 网格当前渲染哪一份数据：模板只有一段 .grid（卡片共用），靠这个切数据源。
     * 搜索态优先 —— dySearching 为真时即使 dyItems 里还有旧分类数据也不显示。 */
    dyViewItems() {
      return this.dySearching ? this.dySearchItems : this.dyItems;
    },
    // 网格「无内容」判定的 loading 也分状态，否则搜索时会被浏览态的 dyLoading 干扰
    dyViewLoading() {
      return this.dySearching ? this.dySearchLoading : this.dyLoading;
    },
    /* 搜索行显什么字：有词就显示词（让人知道再点是重搜/修改），没搜过给提示语。
     * 提示语写「主播 / 游戏」而不是泛泛的「关键词」—— searchLive 的匹配逻辑
     * 只覆盖 title + streamer 两个字段。 */
    dySearchHint() {
      if (this.dyKeyword) return this.dyKeyword;
      return '搜索主播 / 游戏';
    },
    // 码率四档（模板用；顺序 = 原画/蓝光4M/超清/高清）
    dyRateOptions() {
      return DY_RATE_OPTIONS;
    },
    // 当前房间热度文案（服务层归一化时已算好 onlineText，别再自己换算单位）
    dyOnlineText() {
      return this.dyPlaying ? this.dyPlaying.onlineText || '' : '';
    },
    /* 直播「已播时长」：直播 durationMs=0、positionMs 也不可靠（换链会归零），
     * 所以用本机时钟差，格式沿用 formatDuration。
     *
     * 为什么依赖 dyElapsedSec 而不是直接算 Date.now()：computed 只在其**响应式**
     * 依赖变化时重算，Date.now() 不是响应式的 —— 直接写会让数字冻结在开播那一刻
     * （真机表现为「已播 00:05」永远不动）。由 startPoll 的 tick 每秒写一次
     * dyElapsedSec，才既准时又不额外起定时器。 */
    liveElapsedText() {
      if (!this.dyStartedAt) return '00:00';
      /* formatDuration(0) 返回空串，但直播刚开播那几秒必须显式显示 00:00，
       * 否则左列会闪一下空白。 */
      return formatDuration(this.dyElapsedSec || 0) || '00:00';
    },
    // 当前实际码率档位：服务端会就近取档（请求 0 可能给 4），必须回显 session.qn
    dyRateLabel() {
      const s = this.play.session;
      const r = s && s.qn != null ? s.qn : this.dyRate;
      return dyRateName(r);
    },
    /* holeVisible：只在视频像素真的在 fb 上时为真 —— 根节点据此套 .page-live
     * （透明背景）让 KMS 视频平面透出来。未起播/起播失败/已播完必须用不透明底色，
     * 否则会把上一屏的 fb 残留像素透出来。 */
    holeVisible() {
      return this.mode === 'play' && (this.play.state === 'playing' || this.play.state === 'paused');
    },
    idleText() {
      if (this.play.state === 'loading') return '取流中…';
      if (this.play.state === 'error') return '起播失败 · 返回列表';
      /* 直播下播与点播播完是两种语义：这里只说直播（纯斗鱼版没有点播）。 */
      if (this.play.state === 'ended') return '直播已结束';
      return '';
    },
    infoTitle() {
      return this.play.session ? this.play.session.title : '';
    },
    infoUp() {
      return this.play.session ? this.play.session.up : '';
    },
    /* 左列「主播名」行：主播名 · 热度（这一行只有 14px 高、193px 宽，
     * 热度写在这最省位置）。注意斗鱼条目的 up 就是 streamer
     * （onPlayDouyu 里补的，因为 play_session 造 session 时读的是 item.up）。 */
    pupText() {
      const up = this.infoUp || '';
      const hot = this.dyOnlineText;
      if (!hot) return up;
      return up ? up + ' · ' + hot : hot;
    },
    /* 当前播放会话是不是直播。
     * 判据只能看 session.live：play_session.js 的 openVideo 会把 resolveLiveUrl()
     * 的 live:true 原样带进 session，而 session 是播放页唯一的真相源
     * （idlePlay() 的 session 是 null）。不能看 durationMs===0 —— 纯斗鱼版只有直播，
     * 但保留这条判据的意义在于"会话还没建立"与"会话是直播"两种状态必须能区分。 */
    isLivePlay() {
      return this.mode === 'play' && !!(this.play.session && this.play.session.live === true);
    },
    // 图标表（模板只用 logo 与 back）
    ic() {
      return { back: icBack, logo: icLogo };
    }
  },
  async created() {
    this.gen = 0;
    this._timers = new Set();
    this._intervals = new Set();
    this._poll = 0;
    /* 播放器实现选择（v1=旧 player.c，v2=新 player2 模块）在这里一次性读盘：
     * 之后每次 open/status 都走内存值，热路径不碰 storage（storage 是同步 FS 调用，
     * 每秒一次轮询里读盘会拖慢 QuickJS 主线程）。 */
    this._playerImpl = await player.loadPlayerImpl();
    /* 屏幕保活状态：_keepOn=当前是否在保活；_bgPaused=这次暂停是退后台触发的
     * （回前台要自动恢复），用户手动暂停的不动。 */
    this._keepOn = false;
    this._bgPaused = false;
    this._noKeep = false; // 诊断种子可置 true 关闭保活（保持息屏前提）
    /* _noFrameAt = 「连续无视频帧」这个状态是从什么时候开始的（0=当前有帧）。
     * 用途：无首帧看门狗（NO_FRAME_FAIL_MS）—— frames 恒为 0 时没有"上次出帧时刻"
     * 可比，只能靠"零帧已经持续多久"判断起播是不是真死了。用滚动计时而不是
     * "起播时刻"：这样 recover 后重新零帧也能被兜住。 */
    this._noFrameAt = 0;
    /* 直播会话状态：
     *   _livePlayed          = 本会话是否**曾经**出现过 playing（判「下播」时用来
     *                          排除「刚进页面还没起播」—— 那时 state 同样是 idle）
     *   _liveReconnectLogged = 「直播重连中…」是否已打过日志（避免每秒刷屏）
     *   _dyRefreshing        = 换链进行中（防重入：换链要重新签名 + stop/open，
     *                          一轮 tick 里若并发两次会把管线打断；同时它也是
     *                          isLiveEnded 判据的让位开关 —— 换链期间 state 会短暂
     *                          落回 idle，不加这个开关会被误判「直播已结束」）。 */
    this._livePlayed = false;
    this._liveReconnectLogged = false;
    this._dyRefreshing = false;
    /* 系统输入法（搜索）会话中标志：拉起输入法会触发宿主 onHide，
     * 用它在 onHide 里跳过清理，否则 gen++ 会把确认结果丢掉。 */
    this.imBusy = false;
    await this.loadLocal();
  },
  methods: {
    /* ---------- 基础设施 ---------- */
    sleep(ms) {
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          this._timers.delete(t);
          resolve();
        }, ms);
        this._timers.add(t);
      });
    },
    stopPoll() {
      if (this._poll) {
        clearInterval(this._poll);
        this._intervals.delete(this._poll);
        this._poll = 0;
      }
    },
    /* 每次操作传入 ctx（generation 变化即视为过期，用于回调里放弃结果）。
     *
     * UA / Referer 固定为斗鱼 —— 纯斗鱼版没有第二个站点会走到这里。
     * 这条曾经是真 bug：PenBili 原样写死 B 站的 DEFAULT_UA / REFERER 时，
     * native curl 会带 `-e https://www.bilibili.com/` 去拉斗鱼 CDN（真机
     * /tmp/pb2/argv-curl.txt 看到 -e bilibili），斗鱼 CDN 虽不校验 Referer，
     * 但带着错的站点标识既会误导排查，也可能哪天被 CDN 侧按 Referer 拒。 */
    makeCtx(myGen) {
      return {
        player: player,
        mediaUa: DOUYU_UA,
        mediaReferer: DOUYU_REFERER,
        // 直播码率档（0/4/3/2）：play_session 的 douyuRateFor(ctx) 优先读它
        douyuRate: this.dyRate,
        // 帧率上限档位：liveFpsCapFor(ctx.videoSettings) 读它算 fpsCap
        videoSettings: this.videoSettings,
        log: logWarn,
        cancelled: () => this.gen !== myGen
      };
    },
    /* 斗鱼卡片副标题：主播名 · 分类。
     * 为什么不直接在模板里写 `{{ it.streamer }}<template v-if="it.category"> · …`：
     * falcon 的模板对「文本插值 + 内嵌 template」的拼接实测会漏渲染后半段，
     * 统一在方法里拼好字符串最稳。 */
    dyMeta(it) {
      if (!it) return '';
      const parts = [];
      if (it.streamer) parts.push(it.streamer);
      if (it.category) parts.push(it.category);
      return parts.join(' · ');
    },

    /* ---------- 首屏 ---------- */
    /* 首屏入口：读设置 + 拉分类树 + 拉推荐列表。
     * 分类失败只写 dyStatus（可重试），绝不因此不显示页面：这是用户开机第一屏，
     * 白屏比空列表糟得多。 */
    async loadLocal() {
      this.videoSettings = await loadVideoSettings();
      /* 自检种子（storage 预置，真机自动化用）：只保留对本页仍有效的三项 ——
       *   noKeep        = 强制关闭屏幕保活（验证"息屏后不会自己亮屏"）
       *   pollEvery     = 巡检日志间隔秒数
       *   probeLiveEnd  = 直播「下播」判据的引擎级自证（纯计算，不取流不播放不亮屏）
       * B 站时期那些 soak/playProbe/wbiStress 探针已随 B 站功能一起删除。 */
      const at = await getJson(KEYS.autotest, null);
      if (isAutotestSeedEnabled(at)) {
        const seed = readAutotestSeed(at);
        this._pollEvery = seed.pollEvery;
        this._noKeep = seed.noKeep;
        if (this._noKeep) logWarn('[douyu] noKeep=1 → 关闭屏幕保活（诊断模式）');
        if (seed.probeLiveEnd) this.runLiveEndProbe();
        logWarn('[douyu] autotest seeded → pollEvery=' + this._pollEvery);
      }
      await this.loadDyCategories();
      await this.selectDyCate(0);
    },

    /* ---------- 斗鱼：分类 / 列表 ---------- */
    // 一级分类只拉一次（分类树是静态的：5 个一级 / 55 个二级）
    async loadDyCategories() {
      if (this.dyCates.length) return;
      try {
        const list = await fetchCategories();
        if (Array.isArray(list) && list.length) {
          this.dyCates = list;
        } else if (!this.dyStatus) {
          // 服务层失败返回 []，不 throw：给用户一条能看懂的兜底提示
          this.dyStatus = '分类拉取失败，可先看推荐';
        }
      } catch (e) {
        this.dyStatus = '分类拉取失败，可先看推荐';
      }
    },
    /* 选一级分类（左栏竖排）→ 重置到该类下的「推荐」二级。
     * 搜索态下左栏分类仍然可见可点（那是全局导航，不该被搜索屏蔽）：用户点分类的
     * 意图一定是「离开搜索结果去看分类」，所以先退出搜索再判断是否变化 ——
     * 否则在搜索态点「当前已选中」的那个一级分类会命中 early return，什么都不会发生，
     * 表现为「点了没反应」的死键。 */
    async selectDyTop(id) {
      if (this.dySearching) this.onExitDySearch();
      if (this.dyTop === id) return;
      this.dyTop = id;
      await this.selectDyCate(0);
    },
    // 选二级分类（内容区顶部横排）。cid2=0 表示推荐（mixList 的 0_0 段）
    async selectDyCate(cid2) {
      // 兜底：任何进入分类浏览的路径都要先离开搜索态
      if (this.dySearching) this.onExitDySearch();
      const myGen = ++this.gen;
      this.stopPoll();
      this.dyCid2 = cid2 || 0;
      this.dyItems = [];
      this.dyPage = 1;
      this.dyTotal = 0;
      this.dyNoMore = false;
      this.dyStatus = '';
      await this.loadDyPage(myGen, 1, true);
    },
    /* 拉一页斗鱼列表。replace=true 覆盖（切分类），false 追加（加载更多）。
     * total 是服务端总页数 pgcnt，用它判「没有更多」，不靠 items.length<pageSize 猜。 */
    async loadDyPage(myGen, page, replace) {
      this.dyLoading = true;
      try {
        const r = await fetchLiveList(this.dyCid2, page);
        if (this.gen !== myGen) return;
        if (!r || !r.ok) {
          this.dyStatus = '加载失败：' + ((r && (r.errorText || r.error)) || '网络异常');
          return;
        }
        const items = Array.isArray(r.items) ? r.items : [];
        // 尾部裁到列数整数倍（末行不满会露出半行残缺卡片）
        const merged = replace ? items : this.dyItems.concat(items);
        const cut = trimToGridRows(merged, GRID_COLS);
        this.dyItems = cut.items;
        this.dyPage = page;
        this.dyTotal = r.total || 0;
        /* 「没有更多」判定：服务端 pgcnt 是总页数，用它而不是 items.length<pageSize 猜
         * （斗鱼末页可能就是不满的，猜法会漏一页）。裁掉的余数不算「有更多」。 */
        this.dyNoMore = !items.length || (this.dyTotal > 0 && page >= this.dyTotal);
        this.dyStatus = this.dyItems.length ? '' : '这个分类暂时没有直播间';
      } catch (e) {
        if (this.gen === myGen) this.dyStatus = '加载失败：网络异常';
      } finally {
        if (this.gen === myGen) this.dyLoading = false;
      }
    },
    async loadMoreDy() {
      if (this.dyLoading || this.dyNoMore) return;
      await this.loadDyPage(this.gen, this.dyPage + 1, false);
    },

    /* ---------- 斗鱼：搜索 ---------- */
    /* 搜索行右侧按钮：浏览态 = 拉起输入法，搜索态 = 退出搜索回分类浏览。
     * 两个意图完全不同，靠状态分派比塞两个按钮省地方。 */
    async onDySearchBtn() {
      if (this.dySearching) {
        this.onExitDySearch();
        return;
      }
      await this.onOpenDyInput();
    },
    /* 拉输入法搜斗鱼。三点注意：
     *  1) 不动浏览态的 dyItems（两套数据互不污染）
     *  2) 用 dySearching 表达「进入搜索模式」，而不是靠一个 tab 值
     *  3) searchLive 没有翻页参数 → 一次拿完，dySearchNoMore 恒 true（底部不留假入口） */
    async onOpenDyInput() {
      const myGen = this.gen;
      /* 系统输入法是独立系统 miniapp，拉起会触发宿主 onHide。
       * 用 imBusy 让 onHide 跳过清理，否则 gen++ 会把确认结果丢掉。 */
      this.imBusy = true;
      try {
        const r = await input.open({
          value: this.dyKeyword || '',
          placeholder: '搜索主播 / 游戏',
          maxlength: 30
        });
        if (this.gen !== myGen) return;
        if (r && r.error) {
          this.dyStatus = '输入法不可用(' + r.error + ')';
          logWarn('[douyu] input open fail: ' + r.error);
          return;
        }
        const kw = (r && r.confirmed && r.text ? r.text : '').trim();
        // 日志卫生：只记长度不记内容
        logWarn('[douyu] input confirmed=' + !!(r && r.confirmed) + ' kwLen=' + kw.length);
        if (!kw) {
          // 用户取消输入：搜索态保持原样，不把已有结果清掉
          return;
        }
        this.dyKeyword = kw;
        await this.runDySearch(myGen, kw);
      } catch (e) {
        this.dyStatus = '搜索失败：网络异常';
        logWarn('[douyu] search exception: ' + (e && e.message ? e.message : e));
      } finally {
        this.imBusy = false;
      }
    },
    /* 真正发搜索。抽出来是因为「重搜」和「首次搜」需要走同一条路径
     * （搜索态点搜索行也调它，不重复拉输入法）。 */
    async runDySearch(myGen, kw) {
      this.dySearching = true;
      this.dySearchLoading = true;
      this.dySearchItems = [];
      this.dySearchPage = 1;
      this.dySearchNoMore = true; // searchLive 无翻页参数
      this.dyStatus = '搜索「' + kw + '」…';
      try {
        const r = await searchLive(kw, { size: 120 });
        if (this.gen !== myGen) return;
        if (!r || !r.ok) {
          this.dyStatus = '搜索失败：' + ((r && (r.errorText || r.error)) || '网络异常');
          this.dySearchItems = [];
          logWarn('[douyu] search fail: ' + ((r && (r.errorText || r.error)) || 'unknown'));
          return;
        }
        const raw = Array.isArray(r.items) ? r.items : [];
        // 尾部裁到列数整数倍（与网格同一条规则：末行不满会露出半行残缺卡片）
        const cut = trimToGridRows(raw, GRID_COLS);
        this.dySearchItems = cut.items;
        /* via='cate' 是服务层的语义：关键词命中了分类，但该分类里没人把关键词写进
         * 标题/主播名 → 返回的是「这个分类的全部直播」。必须明说，否则用户会以为
         * 搜索结果不相关是 bug。via='direct' 才是真的按词命中。 */
        if (!cut.items.length) {
          this.dyStatus = '没有搜到「' + kw + '」的直播';
        } else if (r.via === 'cate') {
          this.dyStatus = '未找到直接匹配，显示相关分类直播';
        } else {
          this.dyStatus = '搜索「' + kw + '」· ' + cut.items.length + ' 个结果';
        }
        logWarn(
          '[douyu] search ok kwLen=' + kw.length + ' via=' + String(r.via) +
          ' hits=' + raw.length + ' shown=' + cut.items.length +
          (cut.trimmed ? ' trim=' + cut.trimmed : '')
        );
      } catch (e) {
        if (this.gen !== myGen) return;
        this.dyStatus = '搜索失败：网络异常';
        this.dySearchItems = [];
        logWarn('[douyu] search exception: ' + (e && e.message ? e.message : e));
      } finally {
        if (this.gen === myGen) this.dySearchLoading = false;
      }
    },
    /* 退出搜索回分类浏览。dyKeyword 也一起清：留着的话搜索行会一直显示旧词，
     * 而用户已经回到分类视图，看到「搜索行里还有词、网格却是分类」会困惑。
     * 分类列表 dyItems 保留（浏览态数据本来就没被搜索覆盖过）。 */
    onExitDySearch() {
      this.dySearching = false;
      this.dyKeyword = '';
      this.dySearchItems = [];
      this.dySearchPage = 1;
      this.dySearchNoMore = false;
      this.dySearchLoading = false;
      this.dyStatus = '';
      logWarn('[douyu] exit search → 回到分类浏览');
    },

    /* ---------- 斗鱼：播放 ---------- */
    /* 打开斗鱼直播间。
     *  1) 不写播放历史：v2.0.0 已没有历史模块，房间也没有稳定可寻址的深链。
     *  2) 不碰评论/互动接口：斗鱼直播没有可用的匿名互动面，调了也是白调。
     *  3) 取流不走页面：openVideo 内部按 item.site==='douyu' 分流到
     *     resolveDouyuLiveUrl（自动算矩形/帧率/isLive，并透传 liveUrlAt/rates）。 */
    async onPlayDouyu(it) {
      if (!it) return;
      const myGen = ++this.gen;
      this.stopPoll();
      this.mode = 'play';
      /* 「已播时长」的起点（注意必须在覆盖 dyPlaying 之前取旧 rid）：
       *   换房间（rid 变了）→ 必须清零重算，否则会继承上一个房间的时长；
       *   同一房间换码率（onSwitchDyRate 里会暂存再补回）→ 不清零，用户还在看同一个直播；
       *   同一房间重连接管 → 也不清零（下面这个 !dyStartedAt 判断自然保住）。 */
      const prevRid = this.dyPlaying && this.dyPlaying.rid ? this.dyPlaying.rid : 0;
      const nextRid = it.rid || 0;
      this.dyPlaying = it;
      if (!this.dyStartedAt || (prevRid && prevRid !== nextRid)) {
        this.dyStartedAt = Date.now();
        this.dyElapsedSec = 0;
      }
      this.play = {
        state: 'loading',
        session: {
          kind: 'live',
          live: true,
          site: 'douyu',
          roomid: it.rid || 0,
          title: it.title || '',
          up: it.streamer || '',
          desc: '',
          cover: it.cover || '',
          durationMs: 0,
          qn: 0
        },
        positionMs: 0,
        frames: 0,
        note: ''
      };
      const ctx = this.makeCtx(myGen);
      await closeSession(ctx); // 幂等：防止 PLAYER_ALREADY_RUNNING
      if (this.gen !== myGen) return;
      const r = await openVideo(ctx, it);
      if (this.gen !== myGen) {
        if (r && r.ok) await closeSession(this.makeCtx(this.gen));
        return;
      }
      if (!r.ok) {
        if (r.stage === 'cancel') return;
        this.play.state = 'error';
        this.play.note = describePlayError(r);
        logWarn('[douyu] open fail stage=' + r.stage + ': ' + r.message);
        return;
      }
      this.play.session = r.session;
      /* ⚠ 补主播名：openVideo 造 session 时读的是 item.up（沿用的字段名），
       * 而斗鱼条目用的是 item.streamer（normalizeRoom 的字段名），于是
       * session.up 会是空串 —— 左列 .pup 那行就只剩热度，主播名丢了。
       * 只在缺失时补，避免覆盖将来 services 层真把 up 填好的情况。 */
      if (!this.play.session.up) this.play.session.up = it.streamer || '';
      this.play.state = 'playing';
      this.play.note = '';
      this.startKeepScreen(); // 直播同样要保活（暂停思考时也不能黑屏）
      this._avRecoverCount = 0;
      this.startPoll(myGen);
      logWarn(
        '[douyu] play start rid=' + it.rid + ' reqRate=' + this.dyRate +
        ' qn=' + r.session.qn + ' live=' + (r.session.live === true)
      );
    },
    /* 切码率：0 原画 / 4 蓝光4M / 3 超清 / 2 高清。
     * 斗鱼直链按 rate 签名，所以切档 = 重新取流重开（不能原地改档）。
     * 注意回显要用 session.qn：服务端会就近取档（请求 0 可能给你 4），
     * 用 dyRate（请求值）显示会骗用户。 */
    async onSwitchDyRate(rate) {
      const r = Number(rate);
      if (isNaN(r) || r === this.dyRate) return;
      this.dyRate = r;
      const cur = this.dyPlaying;
      if (cur && this.isDouyuPlay) {
        /* 换档 = 重新取流重开。但「已播时长」不该清零 —— 用户视角还在看同一个直播间，
         * 而 onPlayDouyu 只在 dyStartedAt 为 0 时才写，所以这里先暂存再补回。 */
        const started = this.dyStartedAt;
        await this.onPlayDouyu(cur);
        this.dyStartedAt = started || Date.now();
      }
    },
    /* 换链（斗鱼直链一次性，见 DY_URL_REFRESH_MS 注释）。
     * 触发条件：native 报 errcode=17 重连中，或链接临近 expire(300s)。
     * refreshLiveUrl 内部重新签名（fetchPlayInfo），返回新的 url/liveUrlAt/qn；
     * 拿到新链后必须用新 url 重开播放器，不能指望 native 用旧 URL 重连。 */
    async refreshDouyuLive(myGen, st) {
      const s = this.play.session;
      if (!s || s.site !== 'douyu' || s.live !== true) return;
      if (this._dyRefreshing) return;
      const liveAt = Number(s.liveUrlAt) || 0;
      const expired = liveAt > 0 && Date.now() - liveAt >= DY_URL_REFRESH_MS;
      const reconnecting = isLiveReconnecting(st, true);
      if (!expired && !reconnecting) return;
      this._dyRefreshing = true;
      const ctx = this.makeCtx(myGen);
      try {
        const r = await refreshLiveUrl(ctx, s);
        if (this.gen !== myGen) return;
        if (!r || !r.ok) {
          logWarn('[douyu] refresh fail: ' + ((r && (r.message || r.stage)) || 'unknown'));
          return;
        }
        // 先停再开：player2 对「运行中再次 open」的行为不稳，stop 是幂等的
        await player.stop();
        const rect = s.rectPhysical || { x: 213, y: 0, width: 469, height: 266 };
        const o = await player.openSession({
          input: r.url,
          input2: '',
          startMs: 0,
          durationMs: 0, // 直播：时长未知
          fps: 30,
          audio: true,
          transpose: 2,
          rect: rect,
          audioDevice: '',
          userAgent: DOUYU_UA,
          referer: DOUYU_REFERER,
          fpsCap: 30,
          isLive: true
        });
        if (this.gen !== myGen) return;
        if (!o || !o.ok) {
          logWarn('[douyu] reopen fail: ' + ((o && (o.code || o.message)) || 'unknown'));
          return;
        }
        // 写回会话：liveUrlAt 不更新会导致每秒都判「到期」，qn 变了要同步给 UI
        if (r.liveUrlAt) s.liveUrlAt = r.liveUrlAt;
        if (r.qn != null) s.qn = r.qn;
        if (r.douyuRate != null) s.douyuRate = r.douyuRate;
        if (r.rates) s.rates = r.rates;
        this._livePlayed = false; // 重新起播：等下一帧再算「曾经 playing」
        logWarn('[douyu] relink ok qn=' + s.qn);
      } catch (e) {
        logWarn('[douyu] relink exception: ' + (e && e.message ? e.message : e));
      } finally {
        this._dyRefreshing = false;
      }
    },

    /* ---------- 播放轮询（1s：状态同步 + 直播终止判据 + 自愈看门狗 + 换链） ---------- */
    startPoll(myGen) {
      this.stopPoll();
      this._pollLogged = false;
      this._audioDeadWarned = false; // 每次新播放重置音频中断提示状态。
      this._resyncNoteOn = false;
      /* 自愈状态按会话重置：换一个直播间就是新会话，配额重新给满。 */
      this._avRecoverAt = 0;
      this._avRecoverCount = 0;
      this._avQuotaWarned = false;
      this._hardQuotaWarned = false;
      this._screenOffStallLogged = false;
      this._noFrameAt = 0; // 新会话的"连续零帧"计时也归零
      /* 直播会话状态按会话重置：换一场直播要重新判定「有没有播起来过」。 */
      this._livePlayed = false;
      this._liveReconnectLogged = false;
      this._dyRefreshing = false; // 新会话没有在途的换链
      const tick = async () => {
        if (this.gen !== myGen) {
          this.stopPoll();
          return;
        }
        const st = await readStatus(this.makeCtx(myGen));
        if (this.gen !== myGen) {
          this.stopPoll();
          return;
        }
        if (!st.ok) {
          this.play.state = 'error';
          this.play.note = st.message;
          this.stopPoll();
          logWarn('[douyu] poll error: ' + st.message);
          return;
        }
        // 每秒采样（音频/视频/同步证据链）：常规详细状态每 5 秒输出一次，
        // 异常事件（resync/audioDead/gate）即时单独打点。
        this._pollN = (this._pollN || 0) + 1;
        if (this._pollN % (this._pollEvery || 5) === 0) {
          logWarn(
            '[douyu] poll tick frames=' + st.frames + ' pos=' + st.positionMs +
            ' ab=' + st.audioBytes + ' ad=' + st.audioDropped +
            ' u=' + st.audioUnderruns + ' w=' + st.audioWrErrors + ' rd=' + st.audioRingDrops +
            ' stall=' + (st.videoStallMs || 0) + (st.gateActive ? 'G' : '') +
            ' skip=' + (st.videoSkips || 0) + ' drift=' + (st.resyncing ? '?' : (st.avDriftMs || 0)) + 'ms' +
            ' buf=' + (st.audioBufMs || 0) + 'ms' +
            ' vpk=' + (st.videoPipeKb || 0) + ' pal=' + (st.paceAlignMs || 0) +
            ' rst=' + (st.videoRestarts || 0) + ' rs=' + (st.resyncCount || 0) +
            ' lead=' + (st.resyncLeadMs || 0) +
            (st.resyncing ? ' RESYNC(' + (st.resyncingMs || 0) + 'ms)' : '') +
            (st.audioDead ? ' DEAD' : '')
          );
        }
        /* 音画同步分层提示：轻微滞后由 native 平滑快进自愈（不打扰用户）；
         * 过大滞后由 native 强制重同步（视频流重启到音频位置，声音不断）→ 显示
         * 「加载中…」，首帧落屏后 native 清 resyncing，提示自动消失。
         * 只有"恢复确实慢"（>2.5s）才弹，避免提示刷屏 —— 快速自愈只表现为一次极短停顿。 */
        if (st.state === 'playing' && st.resyncing && (st.resyncingMs || 0) > 2500) {
          if (!this._resyncNoteOn) {
            this._resyncNoteOn = true;
            this.play.note = '加载中…';
            // 重同步窗口内 avDriftMs 是伪值（video_base 已前移到 apos+lead、frames=0
            // → 算出来恒等于 -lead），所以这里打 native 的触发漂移 avDriftNowMs。
            logWarn(
              '[douyu] 视频流重启中（强制重同步累计=' + (st.resyncCount || 0) + ' 触发漂移=' +
              (st.avDriftNowMs || 0) + 'ms）已耗时=' + (st.resyncingMs || 0) + 'ms → 加载中…'
            );
          }
        } else if (this._resyncNoteOn) {
          this._resyncNoteOn = false;
          if (this.play.note === '加载中…') this.play.note = '';
        }
        // 音频链已断时只在播放中提示：视频播完后音频进程正常结束也会置 audioDead，
        // 不能在"已播完"后再追加无声提示。
        if (st.audioDead && st.state === 'playing' && !this._audioDeadWarned) {
          this._audioDeadWarned = true;
          this.play.note = '无声：音频输出被其他应用占用';
          logWarn('[douyu] audio chain dead（播放中）→ 音频输出可能被其他应用占用');
        }
        // 起播门诊断：音频等待视频首帧的时长（正常=首帧耗时；15000=超时放行）
        if (st.gateWaitMs > 400 && st.gateWaitMs !== this._lastGateMs) {
          this._lastGateMs = st.gateWaitMs;
          logWarn('[douyu] A/V gate wait=' + st.gateWaitMs + 'ms（音频等视频首帧后同步开播）');
        }
        // 音画起播差（验证定格门）：audioLateVisibleMs = 声音比画面首帧晚多久开写。
        // 定格门生效时应接近 0；若仍是几百毫秒，说明门没起作用。
        if (st.audioLateVisibleMs >= 0 && st.audioLateVisibleMs !== this._lastAudioLateMs) {
          this._lastAudioLateMs = st.audioLateVisibleMs;
          logWarn('[douyu] A/V 音画起播差=' + st.audioLateVisibleMs + 'ms（声音比画面可见晚多少，定格门应压到 ~0；总启动 ' + st.audioLateMs + 'ms）');
        }
        /* ---------- 自愈看门狗 ----------
         * 三个必守约束（真机踩出来的）：
         *  1) 动作要分级：native 有 recover() 就调它（原地重挂平面/重连，不动进程），
         *     绝不为了"对齐一下"杀掉整条管线重建（那会让画面卡住好几秒）。
         *  2) **必须带 !screenOff**：息屏后视频 vsink 不再消费帧 → videoStallMs 持续
         *     增长，而音频进程仍在写 → "视频 8s 无新帧但音频在播"成立，看门狗会判定
         *     管线卡死并重启。可息屏期间画面停滞是**完全正常**的。
         *  3) 要有冷却与配额：弱网下停帧是常态，短冷却会让看门狗连环触发，
         *     每次都往管线里塞一次恢复动作，反而把它拖死。
         */
        const screenOff = this.isScreenOff(st);
        const now = Date.now();
        const cooldownOk = !this._avRecoverAt || now - this._avRecoverAt > WATCHDOG_COOLDOWN_MS;
        const quotaOk = (this._avRecoverCount || 0) < WATCHDOG_MAX_RECOVER;
        /* 直播标志：本 tick 内反复用（终止判据 + 重连提示），取一次避免多次走 computed。 */
        const isLivePlay = this.isLivePlay;
        /* 先算重连标志：正在重连时 state 理论上仍是 playing（native2 约定不动 state），
         * 但万一日后实现改了把它置回 idle，也不能把「重连中」误报成「已结束」——
         * 这两个提示的语义完全相反（等一会儿就好 vs 别等了）。 */
        const liveReconnecting = isLivePlay && isLiveReconnecting(st, isLivePlay);
        /* ---------- 换链（必须在终止判据之前） ----------
         * 斗鱼直链是一次性的（同一 URL 第二次 GET 必 EOF），native「用原 URL 重连」
         * 必定失败，所以 errcode=17 或链接临近 expire 时必须重新签名拿新链。
         * 放在 isLiveEnded 之前判：换链期间 state 可能短暂落回 idle，若先跑终止判据
         * 就会把「正在换链」误报成「直播已结束」，语义正好相反。
         * 不 await：换链要 1~2 秒，等它会把同一 tick 里的其他看门狗全拖慢。 */
        if (isLivePlay && this.play.session && this.play.session.site === 'douyu') {
          this.refreshDouyuLive(myGen, st);
        }
        /* ---------- 直播终止判据 ----------
         * 直播没有时长，走不了「播到末尾」这套判据。主播下播时 native 发 EOS →
         * patch_state(STOPPED) → normalizeState 归一成 'idle'，而 `st.state === 'ended'`
         * 分支在 native 上永远不可达 → 界面停在「播放中」。所以必须在这里独立判。
         *
         * 为什么必须放在自愈看门狗之前：下播后管线还在但不再出帧，videoStallMs 会
         * 一路涨，两个 stall 看门狗会把「正常下播」当成假死，反复恢复重连 ——
         * 用户看到的是界面卡住 + 无任何提示。
         *
         * 注意直播位置是墙钟（native live_position_ms()），EOS 后照样每秒 +1000，
         * 所以**不能**用「位置停止增长」判结束，只能看 state 落回 idle/ended。 */
        if (!liveReconnecting && !this._dyRefreshing && isLiveEnded(st, isLivePlay, this._livePlayed)) {
          this.play.state = 'ended';
          this.play.note = ''; // 清掉「直播重连中…」之类残留
          this.play.frames = st.frames;
          this.play.positionMs = st.positionMs;
          this.stopPoll();
          logWarn(
            '[douyu] live ended（直播终止判据）state=' + st.state +
            ' pos=' + st.positionMs + ' frames=' + st.frames +
            ' played=' + (this._livePlayed ? 1 : 0) +
            ' alive=' + (st.pipelineAlive ? 1 : 0) +
            ' → 停轮询，界面显示「直播已结束」'
          );
          return;
        }
        // 息屏期间画面停滞是正常现象，不判故障（但仍然每 5s 打一行日志留证据）
        if (screenOff && st.state === 'playing' && st.videoStallMs > 8000 && !this._screenOffStallLogged) {
          this._screenOffStallLogged = true;
          logWarn('[douyu] 息屏期间 videoStall=' + st.videoStallMs + 'ms（正常，画面不在屏上）→ 看门狗让位');
        }
        if (!screenOff) this._screenOffStallLogged = false;

        /* ---------- 无首帧兜底看门狗 ----------
         * 两个 stall 看门狗都建立在「videoStallMs 会增长」之上，但 videoStallMs
         * 只在"出过帧之后"才有意义：一帧都没出时 native 返回哨兵 -1（readStatus
         * 已归一化成 0），0 > 8000 恒 false → 两个看门狗都永远不触发。
         * 判据：还在等起播（opening/loading）或累计帧数仍为 0，且这种状态已经
         * 连续持续超过 15s → 直接判失败，不再等帧间隔指标。用**滚动计时**
         * （_noFrameAt）而不是"起播时刻"：这样 recover 后重新零帧也能兜住，
         * 同时只要中途出过帧（frames > 0）就清零重新计。 */
        const waitingFrames =
          st.state === 'opening' ||
          st.state === 'loading' ||
          (st.state === 'playing' && st.frames === 0);
        /* 直播重连期间让位：重连必然伴随 frames 停涨（最坏 45s = 重试 3 × 15s），
         * 按 15s 判失败会把「等一会儿就好」直接判死。native 侧有硬上限
         * （45s 后自己报错 → state=error → 走页面失败路径），这里不需要再加时间闸。 */
        if (waitingFrames && !liveReconnecting && !screenOff) {
          if (this._noFrameAt <= 0) this._noFrameAt = now;
          const noFrameMs = now - this._noFrameAt;
          if (noFrameMs > NO_FRAME_FAIL_MS) {
            this._noFrameAt = 0;
            logWarn(
              '[douyu] 无首帧 ' + noFrameMs + 'ms（state=' + st.state + ' frames=' + st.frames +
              ' stall=' + st.videoStallMs + ' gate=' + st.gateWaitMs +
              '）/ 阈值 ' + NO_FRAME_FAIL_MS + 'ms → 判起播失败，停止轮询让用户返回重试'
            );
            this.play.state = 'error';
            this.play.note = '起播失败 · 可返回重试';
            this.stopPoll();
            return;
          }
        } else {
          // 出过帧 / 不在等起播 → 计时归零，下次零帧重新起算
          this._noFrameAt = 0;
        }

        // A/V 一致性巡检：视频 8s 无新帧而音频仍在写 → 原地恢复（不重启管线）
        if (
          !screenOff &&
          /* 直播重连中让位：native 自己正在重连（最坏 45s），JS 再动手只会
           * 和它抢管线；等 native 报错（state=error）或恢复，页面各自有路径。 */
          !liveReconnecting &&
          st.state === 'playing' &&
          !st.gateActive &&
          // 重同步期间让位，但**有限让位**——超过 15s 仍未恢复就交回 JS 兜底，
          // 否则一旦 native 侧重启卡死，两个看门狗都被压住 → 画面永久冻结。
          (!st.resyncing || (st.resyncingMs || 0) > 15000) &&
          st.videoStallMs > 8000 &&
          st.audioBytes > 0 &&
          st.audioBytes !== (this._lastAvAudioBytes || 0)
        ) {
          if (cooldownOk && quotaOk) {
            this._avRecoverAt = now;
            this._avRecoverCount = (this._avRecoverCount || 0) + 1;
            logWarn(
              '[douyu] A/V stall: video ' + st.videoStallMs + 'ms 无新帧但音频在播 → 原地恢复' +
              '（第 ' + this._avRecoverCount + '/' + WATCHDOG_MAX_RECOVER + ' 次）pos=' + st.positionMs
            );
            this.play.note = '音画不同步，正在恢复…';
            this.tryRecover(myGen, st, 'av');
          } else if (!quotaOk && !this._avQuotaWarned) {
            this._avQuotaWarned = true;
            logWarn('[douyu] A/V stall 自愈配额已用尽（' + WATCHDOG_MAX_RECOVER + ' 次）→ 不再动手，交给用户');
            this.play.note = '画面已停滞，可返回重进';
          }
        }
        // 僵尸涓流看门狗：视频停帧 ≥25s 且音频字节也不再增长 = 双链路假死
        // （TCP 涓流让 rw_timeout 永不触发，实测可冻结 60s+）。同样先原地恢复。
        if (
          !screenOff &&
          !liveReconnecting &&
          st.state === 'playing' &&
          !st.gateActive &&
          (!st.resyncing || (st.resyncingMs || 0) > 15000) &&
          st.videoStallMs > 25000 &&
          st.audioBytes === (this._lastAvAudioBytes || 0)
        ) {
          if (cooldownOk && quotaOk) {
            this._avRecoverAt = now;
            this._avRecoverCount = (this._avRecoverCount || 0) + 1;
            logWarn(
              '[douyu] hard stall: video ' + st.videoStallMs + 'ms 无帧且音频冻结 → 原地恢复' +
              '（第 ' + this._avRecoverCount + '/' + WATCHDOG_MAX_RECOVER + ' 次）'
            );
            this.play.note = '网络不稳定，正在重连…';
            this.tryRecover(myGen, st, 'hard');
          } else if (!quotaOk && !this._hardQuotaWarned) {
            this._hardQuotaWarned = true;
            logWarn('[douyu] hard stall 自愈配额已用尽（' + WATCHDOG_MAX_RECOVER + ' 次）→ 不再动手');
            this.play.note = '网络异常，可返回重进';
          }
        }
        this._lastAvAudioBytes = st.audioBytes;
        /* 只要还没有任何视频帧就提示「加载中」。原因：起播门 15s 会先放行音频
         * （"极弱网先出声"），此时音频已响但画面仍是冻的 → 用户感受正是"画面卡住
         * 但声音正常"。注意 resyncing（视频流重启）走上面的 2.5s 门槛保持静默自愈。 */
        if (liveReconnecting) {
          /* 直播重连期间画面必然停滞（frames 不再增长），若按下面判定就会挂
           * 「加载中…」，但真实情况是「等几秒就好」—— 语义不同，交给下面的
           * 重连提示统一处理，这里让位。 */
        } else if (st.state === 'playing' && st.frames === 0 && !st.resyncing) {
          if (this.play.note !== '加载中…') {
            this.play.note = '加载中…';
            logWarn('[douyu] 无画面帧（起播/卡死）→ 加载中…');
          }
        } else if (this.play.note === '加载中…' && st.frames > 0) {
          this.play.note = '';
        }
        this.play.positionMs = st.positionMs;
        this.play.frames = st.frames;
        /* 斗鱼直播「已播时长」：每秒在这里推进一次。
         * 为什么不放进 computed：Date.now() 不是响应式依赖，computed 不会因时间流逝重算，
         * 结果就是数字冻在开播那一刻。这个 tick 本来就在跑（1s 一次），白捡一个时钟。
         * 直播期间换链不影响 dyStartedAt，所以「已播」是真正的观看时长，不会因为重连归零。 */
        if (this.play.session && this.play.session.site === 'douyu' && this.dyStartedAt) {
          this.dyElapsedSec = Math.max(0, Math.floor((Date.now() - this.dyStartedAt) / 1000));
        }
        /* 直播「曾经播起来过」的事实记录：主播下播就在我们点进去的瞬间发生时，
         * 轮询（1s 一次）可能一次都抓不到 playing，只有 idle —— 若不留这条历史，
         * isLiveEnded() 就只能靠 frames>0 兜底（位置不行：直播位置是墙钟，
         * 一进页面就有值）。一旦确认 playing 就置位、会话内不清。 */
        if (isLivePlay && st.state === 'playing' && !this._livePlayed) {
          this._livePlayed = true;
        }
        /* ---------- 直播重连提示 ----------
         * native 直播走 souphttpsrc（timeout=15s、retries=3），最坏 45 秒画面冻住而
         * state 仍是 playing，用户没有任何反馈。native2 在重连开始时 patch_error
         * (PB2_E_LIVE_RECONNECT=17)（**不动 state**），重连成功清零。
         * 这里只负责翻译成提示：出现就挂「直播重连中…」，消失就撤。
         * 只撤自己挂的那句 —— 别把别人（音画恢复/加载中）的提示清掉。 */
        if (isLivePlay) {
          if (liveReconnecting) {
            /* 只在「不是这句」时赋值 —— 别让每秒一次的 tick 反复重写同一个字符串。 */
            if (this.play.note !== LIVE_RECONNECT_NOTE) {
              this.play.note = LIVE_RECONNECT_NOTE;
            }
            if (!this._liveReconnectLogged) {
              this._liveReconnectLogged = true;
              logWarn(
                '[douyu] live reconnect（直播重连中）code=' + st.lastError +
                ' msg=' + (st.lastErrorMsg || '') + ' pos=' + st.positionMs
              );
            }
          } else {
            /* 只撤自己挂的那句 —— 别把「加载中…」「音画不同步…」的提示清掉。 */
            if (this.play.note === LIVE_RECONNECT_NOTE) this.play.note = '';
            /* 日志标志必须无条件复位：提示可能已被上面的「加载中…」覆盖，
             * 若只跟着 note 复位，下一次重连就再也打不出日志了。 */
            if (this._liveReconnectLogged) {
              this._liveReconnectLogged = false;
              logWarn('[douyu] live reconnect 已恢复 pos=' + st.positionMs + ' frames=' + st.frames);
            }
          }
        }
        if (st.state === 'ended') {
          this.play.state = 'ended';
          this.play.note = ''; // 播完时清掉残留提示。
          this.stopPoll();
          logWarn('[douyu] live ended frames=' + st.frames);
        } else if (st.state === 'paused') {
          this.play.state = 'paused';
        } else if (st.state === 'playing') {
          this.play.state = 'playing';
        }
      };
      this._poll = setInterval(() => {
        tick();
      }, 1000);
      this._intervals.add(this._poll);
    },
    async onTogglePlay() {
      const st = this.play.state;
      if (st !== 'playing' && st !== 'paused') {
        this.play.note = '当前不可控制（' + (STATE_LABELS[st] || st) + '）';
        return;
      }
      const myGen = this.gen;
      const wasPlaying = st === 'playing';
      const r = await togglePlay(this.makeCtx(myGen), wasPlaying);
      if (this.gen !== myGen) return;
      if (!r.ok) {
        this.play.note = r.message;
        logWarn('[douyu] toggle fail: ' + r.message);
        return;
      }
      if (r.state === 'playing' || r.state === 'paused') this.play.state = r.state;
      else this.play.state = wasPlaying ? 'paused' : 'playing';
      this.play.note = '';
      logWarn('[douyu] toggle → ' + this.play.state);
    },
    /* 当前是否"真的黑了"（看门狗门禁用）——只有背光断电才算，两级优先：
     *  1) native `status().screenOff`（player2 直接读 /sys/class/backlight/*\/bl_power，
     *     true=背光断电、false=背光上电）；
     *  2) 回退 brightness JSAPI 的 getScreenState()：0=亮屏、3=调暗、1=熄屏断电、null=拿不到。
     * 两者语义不同（真机实测）：JSAPI 把"调暗 DIM=3"也算非亮屏，但调暗时用户**看得见**
     * 画面，看门狗不该让位 —— 那会把"画面冻死"这种真故障拖成不可恢复。
     * 都拿不到时**当作亮屏**（false）：宁可让看门狗按老逻辑工作，也不能因为探测失败
     * 就永久禁用自愈。 */
    isScreenOff(st) {
      if (st && typeof st.screenOff === 'boolean') return st.screenOff;
      const s = getScreenState();
      if (s == null) return false;
      // JSAPI 回退路径：只有"断电熄屏(1)"算黑屏，调暗(3)仍然可见 → 不让位。
      const n = Number(s);
      return n === 1;
    },
    /* 原地自愈：优先 native recover()（原地重挂平面/重连，不动播放位置）。
     *
     * 为什么不再有"退化到 seek"这一步：PenBili 时代 v2 契约没有 recover() 时会补一次
     * seek(currentPos) 重新解当前帧；纯斗鱼版是直播（FLV 长连接，不能 seek），
     * 且 play_session 的 seek 导出已随点播一起删除 —— 这里只剩 recover 一条路。
     * 失败时只打日志，不动 play.state —— 让轮询继续，下一轮冷却后还能再试。 */
    async tryRecover(myGen, st, tag) {
      const ctx = this.makeCtx(myGen);
      const pos = Math.max(0, Number(st && st.positionMs) || 0);
      const r = await recoverSession(ctx);
      if (this.gen !== myGen) return;
      if (r.ok) {
        logWarn('[douyu] ' + tag + ' 自愈: recover() ok state=' + r.state + ' pos=' + pos);
        return;
      }
      logWarn('[douyu] ' + tag + ' 自愈失败（recover）: ' + (r.code || '') + ' ' + (r.message || ''));
    },

    /* ---------- 返回列表 ---------- */
    async onBack() {
      const myGen = ++this.gen;
      this.stopPoll();
      // 主动离开播放页：停保活（真正该停的地方，不是 onHide）
      keepScreenOff();
      this._keepOn = false;
      this._bgPaused = false;
      await closeSession(this.makeCtx(myGen));
      this.mode = 'browse';
      this.play = idlePlay();
      /* 离开播放页就把「已播时长」的起点清掉：下次点进任何房间都从 00:00 开始。
       * 不清的话，回到列表再进来（哪怕换到别的房间）会继承上一次的计时起点。
       * dyPlaying 也一起清 —— liveElapsedText/pupText 都靠它判断当前房间。 */
      this.dyStartedAt = 0;
      this.dyElapsedSec = 0;
      this.dyPlaying = null;
      logWarn('[douyu] back to browse');
    },

    /* ---------- 生命周期：前后台 / 离开播放页 / 卸载 ----------
     *
     * 三种"离开"必须区分开：
     *   1. 应用退到后台（onHide）—— 系统级，用户随时回来。**不能 teardown**：
     *      管线进程被杀掉后回来只会看到黑屏，得再点一次播放（用户报的"要点两次"）。
     *      正确处理：暂停播放 + 保留会话 + 停掉保活定时器，onShow 恢复。
     *   2. 离开播放页（onBack）—— 用户主动结束。停轮询 + 关会话。
     *   3. 卸载（onUnload）—— 页面销毁。teardown（定时器必须清干净）。
     */
    teardown(note) {
      this.gen++;
      this.stopPoll();
      this._timers.forEach((t) => clearTimeout(t));
      this._timers.clear();
      input.dispose(); // 退订系统输入法回调（幂等）
      // 真正离开播放页才停保活；定时器不清干净会在页面销毁后继续跑
      this.stopKeepScreen('teardown');
      this._bgPaused = false;
      if (this.mode === 'play') {
        closeSession(this.makeCtx(this.gen)).then(
          () => {},
          () => {}
        );
        this.mode = 'browse';
        this.play = idlePlay();
      }
      if (note) this.dyStatus = note;
    },
    /* 进入/维持播放态 → 启动 20s 屏幕保活（播放态和暂停态都要保活）。
     * 幂等：screen.js 内部是单例 keeper，重复调用只返回当前状态。
     *
     * 注意周期必须 < 30s：`hal-screen keep` 自身只续 30 秒窗口，且 30s 就是第一级
     * 调暗阈值（真机 /etc/input-event-daemon.conf 的 [Idle]）。KEEP_INTERVAL_MS=20000。 */
    startKeepScreen() {
      if (this._noKeep) return; // 诊断模式（noKeep）下不保活，保持息屏前提
      if (this._keepOn) return;
      this._keepOn = keepScreenOn();
      if (this._keepOn) {
        logWarn(
          '[douyu] 屏幕保活启动 backend=' + (keepScreenBackend() || 'probe-pending') +
          ' interval=' + KEEP_INTERVAL_MS / 1000 + 's'
        );
      } else {
        logWarn('[douyu] 屏幕保活不可用（brightness JSAPI 缺失）→ 30s 后系统会自动调暗，需 native 侧兜底');
      }
    },
    /* 停保活（onHide/teardown 共用）。必须打一行含 ticks 的日志：
     * 两次进出播放态后应看到 ticks=0 重新计数 —— 若看到两套 #N 交错，就是定时器泄漏。 */
    stopKeepScreen(where) {
      const wasOn = this._keepOn || isKeepingScreen();
      const ticks = keepScreenTicks();
      keepScreenOff();
      this._keepOn = false;
      if (wasOn) logWarn('[douyu] 屏幕保活停止（' + where + '）ticks=' + ticks);
    },
    onShow() {
      /* 回前台：若退后台时暂停过播放，这里恢复。
       * 只恢复"我们自己暂停的那一次"，用户手动暂停的不动。
       * 不自动联网（列表/播放状态原样保留）。 */
      if (this.mode === 'play' && this._bgPaused) {
        this._bgPaused = false;
        this.startKeepScreen();
        const myGen = this.gen;
        togglePlay(this.makeCtx(myGen), false).then(
          (r) => {
            if (this.gen !== myGen) return;
            if (r && r.ok) {
              if (r.state === 'playing' || r.state === 'paused') this.play.state = r.state;
              logWarn('[douyu] onShow → 恢复播放 state=' + this.play.state);
            } else {
              logWarn('[douyu] onShow 恢复失败: ' + ((r && r.message) || '未知'));
            }
          },
          (e) => logWarn('[douyu] onShow 恢复异常: ' + (e && e.message))
        );
        return;
      }
      // 后台期间保活被停过，回前台仍处播放态则重启
      if (this.mode === 'play') this.startKeepScreen();
    },
    onHide() {
      // 系统输入法拉起/关闭会触发 onHide —— 输入会话中不做任何处理
      //（否则 gen++ 会让输入确认结果被丢弃：表现为"返回后显示已停止且无内容"）
      if (this.imBusy) {
        logWarn('[douyu] onHide during IM session → skip');
        return;
      }
      /* 应用退后台：**保留会话**，只暂停 + 停保活。
       *
       * 为什么暂停而不是让它后台播：本机音频输出是独占的（alsasink），后台继续播会
       * 抢走其他应用的音频；而且息屏后视频 vsink 不消费帧，白占 CPU。
       * 为什么不能 teardown：旧实现在这里 teardown，回来时播放器进程已经没了，
       * 用户看到黑屏必须再点一次 —— 这正是"要点两次"的一半成因。
       *
       * 保活必须**连定时器一起停**：应用在后台还每 20s 唤一次屏，等于永不熄屏（烧屏风险），
       * 也白耗电。onShow 会重新 startKeepScreen()，所以停是安全的。 */
      if (this.mode === 'play' && (this.play.state === 'playing' || this.play.state === 'paused')) {
        this.stopKeepScreen('onHide');
        if (this.play.state === 'playing') {
          this._bgPaused = true;
          const myGen = this.gen;
          // 不 await：onHide 是同步生命周期，await 会拖住系统
          togglePlay(this.makeCtx(myGen), true).then(
            (r) => {
              if (this.gen !== myGen) return;
              if (r && r.ok) {
                this.play.state = 'paused';
                logWarn('[douyu] onHide → 暂停并保留会话（回前台恢复）');
              } else {
                logWarn('[douyu] onHide 暂停失败: ' + ((r && r.message) || '未知'));
              }
            },
            (e) => logWarn('[douyu] onHide 暂停异常: ' + (e && e.message))
          );
        }
        return;
      }
      // 非播放态（浏览列表等）：退后台无需保留任何资源
      this.teardown('');
    },
    onUnload() {
      this.teardown('');
    },

    /* ---------- 真机自检（storage 预置 douyu_autotest 触发） ---------- */
    /* 直播「下播」判据的引擎级自证（种子 {enabled:true,autotest:true,probeLiveEnd:true}）。
     *
     * 为什么要在真机上跑这个：判据已有 Node 单测，但真机是 QuickJS，
     * `typeof` / `Number()` / 正则的行为与 V8 可能有细微差异；而真实下播无法随时复现
     * （要等主播关播，或断网等重试耗尽）。用假 status 喂真函数，几毫秒跑完，结论可直接 grep。
     *
     * 不取流、不播放、不亮屏（屏幕保活都不会被这里触发），因此不影响防烧屏纪律。
     * 失败时额外打一行「判据数据源不一致」警告，但不中断后续流程。 */
    runLiveEndProbe() {
      try {
        const r = runLiveEndCases();
        for (let i = 0; i < r.lines.length; i++) logWarn(r.lines[i]);
        if (r.fail > 0) {
          logWarn(
            '[douyu] LIVE-END PROBE 本机引擎结论与 Node 单测不一致：失败 ' +
              r.fail + ' 条 —— 判据不可信，「直播已结束」可能误判！' +
              ' 详情见上方 FAIL 行'
          );
          return { ok: false, pass: r.pass, fail: r.fail };
        }
        return { ok: true, pass: r.pass, fail: 0 };
      } catch (e) {
        // 自证代码自身抛错（比如模块加载失败）不能带崩首屏
        logWarn('[douyu] LIVE-END PROBE 异常: ' + ((e && e.message) || e));
        return { ok: false, pass: 0, fail: -1 };
      }
    }
  }
};
</script>

<style lang="less" scoped>
/* 每个 .vue 必须自带 scoped style 且 import base.less，否则 falcon 侧黑屏。
 * 纯斗鱼版的样式全在 styles/base.less 里（按功能分节、单类名，遵守 falcon 的
 * 「禁逗号选择器 / 禁 position:absolute / flex 必须三连」四条铁律）。 */
@import "../../styles/base.less";
</style>
