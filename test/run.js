// 纯逻辑单测（Node 直接运行：node test/run.js）
// 覆盖：MD5 对拍/向量、斗鱼取流签名链路与播放 URL 拼装（doc §1 原样）、
//       net 归一化、player 参数映射与 UA/Referer 校验、屏幕几何与保活、
//       直播画质设置、play_session 直播判据/主动换链/状态归一、
//       斗鱼列表与分类归一、autotest 种子守卫、live_end_probe 判据、
//       native 管线源码契约。不联网：联网用例在 test/douyu_feed_test.js。
const assert = require('assert');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  const ok = () => {
    passed++;
    console.log('  ok  ' + name);
  };
  const bad = (e) => {
    failed++;
    console.log('FAIL  ' + name + ' -> ' + (e && e.message));
  };
  try {
    const r = fn();
    // 异步用例：登记进 pending，由 main 收尾统一等待后再汇总退出；
    // 单用例 10s 看门狗 —— 挂起必须显式报 TIMEOUT，不能被 process.exit 静默吞掉。
    if (r && typeof r.then === 'function') {
      const done = r.then(ok, bad);
      pending.push(
        Promise.race([
          done,
          new Promise((resolve) =>
            setTimeout(() => {
              failed++;
              console.log('FAIL  ' + name + ' -> TIMEOUT(10s)');
              resolve();
            }, 10000)
          )
        ])
      );
      return done;
    }
    ok();
  } catch (e) {
    bad(e);
  }
}

async function main() {

  const { md5Hex } = await import('../src/services/md5.js');
  const { unwrapResponse, tryParseJson, toRuntimeHeader, httpGet } = await import('../src/services/net.js');
  const {
    buildOpenArgs,
    isSafeInput,
    isSafeUserAgent,
    isSafeReferer,
    describeError,
    hasModule,
    openSession,
    resetPlayerModuleCache
  } = await import('../src/services/player.js');
  const {
    fitLogicalRect,
    probeVideoRects,
    logicalToPhysicalPoint,
    isRectInsidePanel,
    playVideoRects,
    VIDEO_AREA,
    LIVE_VIDEO_AREA,
    PHYSICAL,
    PANEL_X_OFFSET,
    BAR_WIDTH,
    GRID_COLS,
    trimToGridRows,
    KEEP_INTERVAL_MS,
    createScreenKeeper,
    keepScreenOnce,
    keepScreenBackend,
    getScreenState,
    isKeepingScreen,
    needsBrightRestore,
    keepRetryNeeded,
    screenStateName,
    KEEP_BRIGHT_MIN,
    KEEP_BRIGHT_RESTORE,
    KEEP_CLOSE_SCREEN_SEC,
    keepScreenOn,
    keepScreenOff,
    keepScreenTicks
  } = await import('../src/services/screen.js');
  const { normalizeStoredValue } = await import('../src/services/storage.js');
  const vsMod = await import('../src/services/video_settings.js');
  const {
    openVideo,
    resolveLiveUrl,
    refreshLiveUrl,
    togglePlay,
    recoverSession,
    readStatus,
    closeSession,
    describePlayError,
    SEEK_STEP_MS,
    LIVE_FPS,
    LIVE_URL_TTL_MS,
    LIVE_URL_REFRESH_MS,
    shouldRefreshLiveUrl,
    num,
    numSigned,
    numLatency,
    normalizeState,
    isLiveEnded,
    isLiveReconnecting,
    LIVE_RECONNECT_ERR
  } = await import('../src/services/play_session.js');
  const { isAutotestSeedEnabled, readAutotestSeed } = await import('../src/services/autotest_seed.js');
  const { runLiveEndCases, LIVE_END_CASES } = await import('../src/services/live_end_probe.js');
  const douyuApi = await import('../src/services/douyu/api.js');
  const douyuNorm = await import('../src/services/douyu/normalize.js');
  const douyuFeed = await import('../src/services/douyu/feed.js');
  const douyuCate = await import('../src/services/douyu/cate.js');
  const fsx = require('fs');
  const pathx = require('path');

  // 设备/接口层常量：产品代码里的唯一来源（不要在用例里另写一份 UA 串）
  const TEST_UA = douyuApi.DOUYU_UA;
  const TEST_REFERER = douyuApi.DOUYU_REFERER;

  const nodeMd5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

  // ---------------- 直播画质设置（「我的」菜单） ----------------

  test('video_settings: 默认值与脏数据归一（只认 liveQuality）', () => {
    const d = vsMod.DEFAULT_VIDEO_SETTINGS;
    assert.strictEqual(d.version, 2);
    assert.strictEqual(d.liveQuality, '720p60');
    // 点播字段已随纯直播重构删除，也不许再从存储里被回吐出来
    assert.strictEqual(d.videoQuality, undefined);
    assert.strictEqual(d.videoFps, undefined);
    assert.strictEqual(d.liveFps, undefined);
    // 脏数据一律退回默认，绝不让一条坏记录把播放搞挂
    assert.deepStrictEqual(vsMod.normalizeVideoSettings(null), d);
    assert.deepStrictEqual(vsMod.normalizeVideoSettings('x'), d);
    // 不存在的旧档位必须回落**默认** 720p60，不能落到列表首项 480p30（画质会莫名变差）
    assert.strictEqual(vsMod.normalizeVideoSettings({ liveQuality: 'auto' }).liveQuality, '720p60');
    assert.strictEqual(vsMod.normalizeVideoSettings({ liveQuality: '1080p' }).liveQuality, '720p60');
    // 归一结果只含契约字段（version + liveQuality）
    assert.deepStrictEqual(
      Object.keys(vsMod.normalizeVideoSettings({ videoQuality: '720p30' })).sort(),
      ['liveQuality', 'version']
    );
    // 合法值保留
    assert.strictEqual(vsMod.normalizeVideoSettings({ liveQuality: '480p30' }).liveQuality, '480p30');
  });

  test('video_settings: 直播档自带 fpsCap 与完整 label（斗鱼只按 rate 取流，帧率本地封顶）', () => {
    for (const q of vsMod.LIVE_QUALITY_OPTIONS) {
      assert.strictEqual(typeof q.fpsCap, 'number', q.id + ' 缺 fpsCap');
      assert.ok(/p\s*\d+fps/.test(q.label), q.id + ' 的 label 没写清分辨率+帧率：' + q.label);
    }
    assert.strictEqual(vsMod.liveFpsCapFor({ liveQuality: '720p60' }), 0, '60fps 档不封顶');
    assert.strictEqual(vsMod.liveFpsCapFor({ liveQuality: '480p30' }), 30);
    assert.strictEqual(vsMod.liveFpsCapFor(null), 0, '脏输入回落默认档（不封顶）');
    assert.strictEqual(vsMod.liveQualityLabel({ liveQuality: '720p30' }), '720p 30fps');
    assert.strictEqual(vsMod.liveQualityLabel(null), '720p 60fps');
  });

  test('video_settings: nextOptionId 轮转（首尾闭合，未知 id 从头开始）', () => {
    const list = vsMod.LIVE_QUALITY_OPTIONS;
    assert.strictEqual(vsMod.nextOptionId(list, list[0].id), list[1].id);
    assert.strictEqual(vsMod.nextOptionId(list, list[list.length - 1].id), list[0].id);
    assert.strictEqual(vsMod.nextOptionId(list, '不存在'), list[0].id);
    assert.strictEqual(vsMod.nextOptionId([], 'x'), 'x');
    assert.strictEqual(vsMod.nextOptionId(null, 'x'), 'x');
  });

  // ---------------- md5 ----------------

  test('md5: 空串向量', () => {
    assert.strictEqual(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  });

  test('md5: "abc" 向量', () => {
    assert.strictEqual(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  });

  test('md5: fox 向量', () => {
    assert.strictEqual(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
  });

  test('md5: 对拍 node crypto（含 55/56/64 填充边界与 UTF-8）', () => {
    const samples = [
      'bar=514&foo=114&wts=1702204169&zab=1919810',
      '中文测试混合ABC',
      'x'.repeat(1000),
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64)
    ];
    for (const s of samples) assert.strictEqual(md5Hex(s), nodeMd5(s), JSON.stringify(s.slice(0, 12)));
  });

  // ---------------- net ----------------

  test('net: unwrapResponse 成功路径默认 200', () => {
    const r = unwrapResponse({ result: '{"a":1}' });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body, '{"a":1}');
  });

  test('net: unwrapResponse error:3 解析 resCode', () => {
    const r = unwrapResponse({ error: 3, result: { errorMessage: 'curl: (28) resCode:504' } });
    assert.strictEqual(r.statusCode, 504);
    assert.ok(r.errorMessage.indexOf('resCode') >= 0);
  });

  test('net: tryParseJson 只解析 JSON 形态文本', () => {
    assert.deepStrictEqual(tryParseJson('{"x":1}'), { x: 1 });
    assert.strictEqual(tryParseJson('not json'), 'not json');
    assert.strictEqual(tryParseJson(''), null);
    assert.strictEqual(tryParseJson('[1,2]').length, 2);
  });

  test('net: toRuntimeHeader 只保留非空字符串值', () => {
    assert.deepStrictEqual(toRuntimeHeader({ 'User-Agent': 'x', Empty: '', n: 3 }), { 'User-Agent': 'x' });
    assert.strictEqual(toRuntimeHeader({}), null);
    assert.strictEqual(toRuntimeHeader(null), null);
  });

  test('net: 无 $falcon 时 httpGet 以 NET_UNAVAILABLE 拒绝', async () => {
    await assert.rejects(() => httpGet('https://x/'), /NET_UNAVAILABLE/);
  });

  // ---------------- player adapter ----------------

  test('player: buildOpenArgs 顺序与钳制（16 个位置参数，含 DASH 第二输入 / fpsCap / isLive）', () => {
    const args = buildOpenArgs({
      input: 'https://x/v.mp4',
      input2: 'https://x/a.m4s',
      startMs: -5,
      durationMs: 1234.6,
      fps: 0,
      audio: false,
      transpose: 1,
      rect: { x: 0.4, y: 174, width: 254, height: 452 },
      audioDevice: '',
      userAgent: 'UA',
      referer: 'https://r/',
      fpsCap: 30,
      isLive: false
    });
    assert.deepStrictEqual(args, [
      // fps=0 → 回落 24（与 native 侧 `fps<1||fps>60 → 24` 一致）
      'https://x/v.mp4', 0, 1235, 24, 0, 1, 0, 174, 254, 452, '', 'UA', 'https://r/', 'https://x/a.m4s', 30, 0
    ]);
    // input2 缺省 → 第 14 位空串（native 据此走单文件 0:a:0）；fpsCap 缺省 → 0（不限帧率）
    const solo = buildOpenArgs({ input: 'https://x/v.mp4', startMs: 0, durationMs: 0, fps: 30, rect: { x: 0, y: 0, width: 1, height: 1 } });
    assert.strictEqual(solo.length, 16);
    assert.strictEqual(solo[13], '');
    assert.strictEqual(solo[14], 0);
    // isLive 缺省 → -1（native 回落严格启发式，不擅自判直播）
    assert.strictEqual(solo[15], -1);
    // 只有明确 true/false 才翻译成 1/0；其它一律 -1（防「点播被猜成直播」P0-3）
    assert.strictEqual(buildOpenArgs({ input: 'a', isLive: true })[15], 1);
    assert.strictEqual(buildOpenArgs({ input: 'a', isLive: false })[15], 0);
    assert.strictEqual(buildOpenArgs({ input: 'a', isLive: undefined })[15], -1);
    assert.strictEqual(buildOpenArgs({ input: 'a', isLive: null })[15], -1);
    assert.strictEqual(buildOpenArgs({ input: 'a', isLive: 1 })[15], -1);
    assert.strictEqual(buildOpenArgs({ input: 'a', isLive: 'true' })[15], -1);
    // fpsCap 非法（负数/NaN）一律归 0，绝不给 native 传负的 max-rate
    assert.strictEqual(buildOpenArgs({ input: 'a', fpsCap: -3 })[14], 0);
    assert.strictEqual(buildOpenArgs({ input: 'a', fpsCap: 'x' })[14], 0);
    assert.strictEqual(buildOpenArgs({ input: 'a', fpsCap: 29.6 })[14], 30);
  });

  test('player: isSafeInput 拒绝空白/../超长/非 http(s)', () => {
    assert.strictEqual(isSafeInput('https://x/v.mp4'), true);
    assert.strictEqual(isSafeInput('/abs/path.mp4'), true);
    assert.strictEqual(isSafeInput('https://x/a b'), false);
    assert.strictEqual(isSafeInput('/a/../etc'), false);
    assert.strictEqual(isSafeInput('https://x/' + 'a'.repeat(1100)), false);
    assert.strictEqual(isSafeInput('ftp://x/v'), false);
    assert.strictEqual(isSafeInput(123), false);
  });

  test('player: UA/Referer 校验与 native 规则一致', () => {
    assert.strictEqual(isSafeUserAgent(TEST_UA), true);
    assert.strictEqual(isSafeUserAgent(''), true);
    assert.strictEqual(isSafeUserAgent(null), true);
    assert.strictEqual(isSafeUserAgent('a'.repeat(256)), false);
    assert.strictEqual(isSafeUserAgent('bad\u0007ua'), false);
    assert.strictEqual(isSafeUserAgent('非ascii夏'), false);
    assert.strictEqual(isSafeReferer('https://www.douyu.com/'), true);
    assert.strictEqual(isSafeReferer('https://a b/'), false);
    assert.strictEqual(isSafeReferer('x'.repeat(513)), false);
    assert.strictEqual(isSafeReferer(''), true);
  });

  test('player: 模块缺失 → PLAYER_NATIVE_MISSING（预期 fallback）', async () => {
    resetPlayerModuleCache();
    assert.strictEqual(await hasModule(), false);
    const r = await openSession({
      input: 'https://x/v.mp4',
      rect: { x: 0, y: 0, width: 2, height: 2 },
      userAgent: TEST_UA
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PLAYER_NATIVE_MISSING');
  });

  test('player: describeError 收录 PLAYER_BAD_HEADERS', () => {
    assert.ok(describeError('PLAYER_BAD_HEADERS').indexOf('请求头') >= 0);
  });

  test('player: v1/v2 开关归一化（非法值一律当未指定）', async () => {
    const P = await import('../src/services/player.js');
    assert.strictEqual(P.normalizeImpl('v1'), 'v1');
    assert.strictEqual(P.normalizeImpl(' V2 '), 'v2');
    assert.strictEqual(P.normalizeImpl('v3'), '');
    assert.strictEqual(P.normalizeImpl(''), '');
    assert.strictEqual(P.normalizeImpl(null), '');
    assert.strictEqual(P.normalizeImpl(1), '');
    // 缺省实现是 v2（新模块）；storage 键名是与运维约定的硬契约
    assert.strictEqual(P.PLAYER_IMPL_DEFAULT, 'v2');
    assert.strictEqual(P.PLAYER_IMPL_KEY, 'douyu_player_impl');
  });

  test('player: setPlayerImpl 切换后丢弃已加载模块（下次调用重新加载）', async () => {
    const P = await import('../src/services/player.js');
    P.resetPlayerModuleCache();
    P.setPlayerImpl('v2');
    assert.strictEqual(P.getPlayerImpl(), 'v2');
    await P.getPlayerModule(); // 两个模块都不存在 → mod=null，但 implName 保持 ''
    P.setPlayerImpl('v1');
    assert.strictEqual(P.getPlayerImpl(), 'v1');
    // 切回缺省
    P.setPlayerImpl('');
    assert.strictEqual(P.getPlayerImpl(), 'v2');
    P.resetPlayerModuleCache();
  });

  test('player: recover() 在无 native 模块时返回 PLAYER_NATIVE_MISSING（不抛）', async () => {
    const P = await import('../src/services/player.js');
    P.resetPlayerModuleCache();
    const r = await P.recover();
    assert.strictEqual(r.ok, false);
    assert.ok(r.code === 'PLAYER_NATIVE_MISSING' || r.code === 'PLAYER_UNSUPPORTED');
  });

  test('player: v2 专有可选接口缺失 → PLAYER_UNSUPPORTED（页面可降级）', async () => {
    const P = await import('../src/services/player.js');
    P.resetPlayerModuleCache();
    for (const fn of ['pauseRender', 'resumeRender', 'redraw']) {
      const r = await P[fn]();
      assert.strictEqual(r.ok, false);
      assert.ok(r.code === 'PLAYER_NATIVE_MISSING' || r.code === 'PLAYER_UNSUPPORTED', fn + ' → ' + r.code);
    }
    assert.ok(P.describeError('PLAYER_UNSUPPORTED').length > 0);
  });

  // ---------------- screen ----------------

  test('screen: 360p 视频区矩形（X6 Pro 逻辑 960x266 / 物理 266x960）', () => {
    const r = probeVideoRects(640, 360);
    assert.deepStrictEqual(r.logical, { x: 234, y: 0, width: 427, height: 240 });
    assert.deepStrictEqual(r.physical, { x: 0, y: 299, width: 240, height: 427 });
    assert.strictEqual(isRectInsidePanel(r.physical), true);
  });

  test('screen: fitLogicalRect 信箱适配', () => {
    const r = fitLogicalRect(1920, 1080);
    assert.strictEqual(r.width, 473); // 960x266 box：16:9 按高适配 → 473x266
    assert.strictEqual(r.height, 266);
    const v = fitLogicalRect(360, 640); // 竖屏稿件
    assert.ok(v.width < v.height);
  });

  test('screen: direction=270 四角与越界钳制', () => {
    // X6 Pro 物理面板 266x960 ⇒ 270 转角：phys.x = 266-1-cy，phys.y = cx
    assert.deepStrictEqual(logicalToPhysicalPoint({ x: 0, y: 0 }, 270), { x: 265, y: 0 });
    assert.deepStrictEqual(logicalToPhysicalPoint({ x: 959, y: 0 }, 270), { x: 265, y: 959 });
    assert.deepStrictEqual(logicalToPhysicalPoint({ x: -5, y: 9999 }, 270), { x: 0, y: 0 });
  });

  test('screen: 越界/非法矩形被拒', () => {
    assert.strictEqual(isRectInsidePanel({ x: 260, y: 0, width: 10, height: 10 }), false); // 260+10 > 266
    assert.strictEqual(isRectInsidePanel({ x: -1, y: 0, width: 10, height: 10 }), false);
    assert.strictEqual(isRectInsidePanel({ x: 0, y: 0, width: 0, height: 10 }), false);
    assert.strictEqual(isRectInsidePanel(null), false);
  });

  // ---- 屏幕保活（缺陷 C 修复）----

  test('screen: 保活周期必须 < 30s（hal-screen keep 只续 30s）', () => {
    assert.strictEqual(KEEP_INTERVAL_MS, 20000);
    assert.ok(KEEP_INTERVAL_MS < 30000, '周期必须小于 hal-screen keep 的 30s 续期窗口');
    // 必须挡住 570s 那一级调暗（113→5）：570s / 20s = 28 次续期，每次都把窗口推后
    assert.ok(570000 / KEEP_INTERVAL_MS >= 20);
  });

  test('screen: createScreenKeeper 定时续期 / stop 后不再调用', async () => {
    let calls = 0;
    const timers = [];
    const keeper = createScreenKeeper({
      call: () => {
        calls++;
      },
      intervalMs: 1000,
      setTimer: (fn, ms) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: (t) => {
        timers[t - 1] = null;
      }
    });
    assert.strictEqual(keeper.isActive(), false);
    assert.strictEqual(keeper.start(), true);
    assert.strictEqual(calls, 1, 'immediate 默认 true → 启动即续一次');
    assert.strictEqual(keeper.start(), false, '重复 start 幂等');
    // 手工推进定时器链
    timers[0]();
    assert.strictEqual(calls, 2);
    timers[1]();
    assert.strictEqual(calls, 3);
    assert.strictEqual(keeper.ticks(), 2);
    assert.strictEqual(keeper.intervalMs(), 1000);
    assert.strictEqual(keeper.stop(), true);
    assert.strictEqual(keeper.isActive(), false);
    assert.strictEqual(keeper.stop(), false, '重复 stop 幂等');
    // stop 后残留回调即使被触发也不得再调用
    timers[2] && timers[2]();
    assert.strictEqual(calls, 3);
  });

  test('screen: keeper immediate=false 不立刻续期', () => {
    let calls = 0;
    const keeper = createScreenKeeper({
      call: () => {
        calls++;
      },
      immediate: false,
      setTimer: () => 1,
      clearTimer: () => {}
    });
    keeper.start();
    assert.strictEqual(calls, 0);
    keeper.stop();
  });

  test('screen: 无 brightness 模块时 keepScreenOnce 静默返回 false（不抛）', () => {
    // Node 环境没有 $falcon / brightness 模块：必须降级而不是崩
    assert.strictEqual(keepScreenOnce(), false);
    assert.strictEqual(keepScreenBackend(), '');
    assert.strictEqual(getScreenState(), null);
    assert.strictEqual(isKeepingScreen(), false);
  });

  test('screen: getScreenState 编号语义（真机实测 0=ON 3=DIM 1=OFF）', () => {
    assert.strictEqual(screenStateName(0), 'ON');
    assert.strictEqual(screenStateName(3), 'DIM');
    assert.strictEqual(screenStateName(1), 'OFF');
    assert.strictEqual(screenStateName(null), '未知');
    assert.strictEqual(screenStateName(7), '未知(7)');
  });

  test('screen: 硬兜底以 state 为主判据（getBrightness 被调暗时仍是 80）', () => {
    // 真机实证：hal-screen down 后 bl_br=5 / bl_power=0，但 getBrightness() 仍返回 80，
    // 所以只靠亮度会漏判 —— 必须靠 state 触发兜底。
    assert.strictEqual(needsBrightRestore(80, 3), true);
    assert.strictEqual(needsBrightRestore(80, 0), false);
    // 熄屏(1)：播放中也要救。真机实证 keepScreenOn() 能把 bp=4 拉回 bp=0；
    // 用户主动按电源键时页面走 onHide → 停保活，这里不会跟他抢。
    assert.strictEqual(needsBrightRestore(80, 1), true);
    // state 读不到时退回亮度判据
    assert.strictEqual(needsBrightRestore(KEEP_BRIGHT_MIN, null), true);
    assert.strictEqual(needsBrightRestore(KEEP_BRIGHT_MIN + 1, null), false);
    assert.strictEqual(needsBrightRestore(null, null), false);
    // 恢复档位必须高于阈值，否则兜底会陷入"救回来又被判为调暗"的循环
    assert.ok(KEEP_BRIGHT_RESTORE > KEEP_BRIGHT_MIN);
  });

  test('screen: 深熄态 keep 需连发两次（retry 判据）', () => {
    /* 真机实测（2026-11-01，hal-screen keep）：从 bp=4 背光断电状态，
     * 第 1 次 keep 只把 /tmp/.screen_state 置 1、bp 仍 4；第 2 次才 bp=0。
     * 所以 keepScreenOnce() 在 keep 后复检 state，仍是 OFF(1) 就再补一次。 */
    assert.strictEqual(keepRetryNeeded(1), true, 'OFF(1) 必须补第二次 keep');
    assert.strictEqual(keepRetryNeeded(0), false, '亮屏不要重复发，省 JSAPI 调用');
    assert.strictEqual(keepRetryNeeded(3), false, 'DIM(3) 由 setBrightness 兜底，无需再 keep');
    assert.strictEqual(keepRetryNeeded(null), false, '读不到状态时交给硬兜底');
    assert.strictEqual(keepRetryNeeded(undefined), false);
    assert.strictEqual(keepRetryNeeded('1'), true, '字符串形态同样识别（JSAPI 可能回字符串）');
  });

  test('screen: 息屏超时档位落在 600~1200s（<1200 才不被 daemon 重置脚本清掉）', () => {
    // /usr/bin/check_stop_input_deamon_times.sh：/tmp/stop_input_event_daemon 超过 1200s 会
    // killall -USR2 input-event-daemon 把配置重置掉，所以设得比 1200 小才有意义。
    assert.ok(KEEP_CLOSE_SCREEN_SEC >= 600, '不能短于 10 分钟，否则退化成频繁调用');
    assert.ok(KEEP_CLOSE_SCREEN_SEC < 1200, '必须小于 daemon 重置阈值 1200s');
  });

  test('screen: 两次进出保活无定时器泄漏（start 幂等 / 计数按会话归零）', () => {
    // 真机踩过的坑：onHide 停保活后如果 keeper 没真停，日志里会出现两条 #N 序列交织。
    // 这里对单例直接断言：重复 start 不得叠第二套定时器，再次 start 计数必须归 0。
    assert.strictEqual(keepScreenOn(), true);
    assert.strictEqual(isKeepingScreen(), true);
    // 启动那一刻的 immediate 续期不计入 keeper.ticks()（ticks 只统计定时器触发的轮次），
    // 所以刚启动时是 0；20s 后才会变成 1。
    assert.strictEqual(keepScreenTicks(), 0);
    // 幂等：重复调用返回"当前仍在保活"，但绝不能叠第二套定时器（计数不变）
    assert.strictEqual(keepScreenOn(), true, '重复调用返回仍在保活');
    assert.strictEqual(isKeepingScreen(), true, '幂等调用不能把已启动的停掉');
    assert.strictEqual(keepScreenTicks(), 0, '幂等调用不得再续期');
    assert.strictEqual(keepScreenOff(), true);
    assert.strictEqual(isKeepingScreen(), false);
    assert.strictEqual(keepScreenOff(), false, '重复 stop 幂等');
    // 第二轮：必须是一套全新的定时器链，计数从 0 起
    assert.strictEqual(keepScreenOn(), true);
    assert.strictEqual(keepScreenTicks(), 0, '新会话计数归零');
    assert.strictEqual(keepScreenOff(), true);
    assert.strictEqual(isKeepingScreen(), false);
  });

  // ---------------- storage 底层 ----------------

  test('storage: normalizeStoredValue 各形态', () => {
    assert.strictEqual(normalizeStoredValue({ data: 'x' }), 'x');
    assert.strictEqual(normalizeStoredValue({ value: 'y' }), 'y');
    assert.strictEqual(normalizeStoredValue({ data: 3 }), '');
    assert.strictEqual(normalizeStoredValue('z'), 'z');
    assert.strictEqual(normalizeStoredValue(null), '');
  });

  // ---------------- autotest 种子守卫（防止普通用户被自动播放打扰） ----------------

  test('autotest: 只有 enabled+autotest 双开关都显式 true 才自动播', () => {
    // 正例：唯一合法的开启形态
    assert.strictEqual(isAutotestSeedEnabled({ enabled: true, autotest: true }), true);
    assert.strictEqual(
      isAutotestSeedEnabled({ version: 1, enabled: true, autotest: true, playProbe: 150, pollEvery: 2, soakBv: 'BV1SDJC6dE4t' }),
      true
    );
  });

  test('autotest: 残留种子（只有 playProbe / 只有 enabled / 缺字段）一律不自动播', () => {
    // 这些正是真机 preferences.json 里会残留的形态 —— 一个都不许触发自动播放
    assert.strictEqual(isAutotestSeedEnabled(null), false);
    assert.strictEqual(isAutotestSeedEnabled(undefined), false);
    assert.strictEqual(isAutotestSeedEnabled({}), false);
    assert.strictEqual(isAutotestSeedEnabled({ playProbe: 150 }), false, '只有 playProbe 数值 → 残留');
    assert.strictEqual(isAutotestSeedEnabled({ enabled: true }), false, '缺 autotest → 残留');
    assert.strictEqual(isAutotestSeedEnabled({ autotest: true }), false, '缺 enabled → 残留');
    assert.strictEqual(isAutotestSeedEnabled({ enabled: true, playProbe: 150, soakBv: 'BV1SDJC6dE4t' }), false);
    // 旧的布尔/字符串写法是历史遗留，不再是开启信号（等于给残留开后门）
    assert.strictEqual(isAutotestSeedEnabled(true), false, '布尔 true 不认');
    assert.strictEqual(isAutotestSeedEnabled('true'), false, '字符串 true 不认');
    assert.strictEqual(isAutotestSeedEnabled([], ), false);
    // 类型必须严格是布尔 true，不接受 'true' / 1 —— 不猜类型
    assert.strictEqual(isAutotestSeedEnabled({ enabled: 'true', autotest: 'true' }), false);
    assert.strictEqual(isAutotestSeedEnabled({ enabled: 1, autotest: 1 }), false);
  });

  test('autotest: readAutotestSeed 对脏值退化（不因一个脏字段触发意外行为）', () => {
    // v2.0.0 纯斗鱼版只剩三个纯诊断开关（都不取流、不播放、不亮屏）
    const empty = readAutotestSeed(null);
    assert.strictEqual(empty.pollEvery, 5, '默认 5s');
    assert.strictEqual(empty.noKeep, false);
    assert.strictEqual(empty.probeLiveEnd, false);
    assert.deepStrictEqual(
      Object.keys(readAutotestSeed({ enabled: true, autotest: true })),
      ['pollEvery', 'noKeep', 'probeLiveEnd'],
      '导出字段面必须只剩这三项 —— 点播探针已随功能删除'
    );

    // 正常种子逐字段还原
    const s = readAutotestSeed({
      version: 1, enabled: true, autotest: true, pollEvery: 2,
      noKeep: true, probeLiveEnd: true
    });
    assert.strictEqual(s.pollEvery, 2);
    assert.strictEqual(s.noKeep, true);
    assert.strictEqual(s.probeLiveEnd, true);

    // 严格布尔：字符串 'true' / 1 都不认
    assert.strictEqual(readAutotestSeed({ enabled: true, autotest: true, noKeep: 'true' }).noKeep, false);
    assert.strictEqual(readAutotestSeed({ enabled: true, autotest: true, probeLiveEnd: 1 }).probeLiveEnd, false);

    // pollEvery 下界 1（诊断时要能设 1s）
    assert.strictEqual(readAutotestSeed({ enabled: true, autotest: true, pollEvery: 0 }).pollEvery, 5);
    assert.strictEqual(readAutotestSeed({ enabled: true, autotest: true, pollEvery: 1 }).pollEvery, 1);
    assert.strictEqual(readAutotestSeed({ enabled: true, autotest: true, pollEvery: -3 }).pollEvery, 5);
    assert.strictEqual(readAutotestSeed({ enabled: true, autotest: true, pollEvery: 'abc' }).pollEvery, 5);
  });


  // ---------------- 斗鱼服务层（纯函数，离线可跑） ----------------

  // 联网行为在 test/douyu_feed_test.js（真打端点）；这里只钉死契约与纯逻辑。

  test('douyu/api: 签名链路与 node crypto 对拍（doc §1 的 md5 循环）', () => {
    const key = 'abcdefghijklmnopqrstuvwxyz';
    // f = rand_str；循环 enc_time 次 f = md5(f + key)
    assert.strictEqual(douyuApi.deriveSigningKey('0123456789abcdef', key, 1), nodeMd5('0123456789abcdef' + key));
    assert.strictEqual(douyuApi.deriveSigningKey('r', key, 0), 'r', 'enc_time=0 时原样返回');
    let want = 'r';
    for (let i = 0; i < 3; i++) want = nodeMd5(want + key);
    assert.strictEqual(douyuApi.deriveSigningKey('r', key, 3), want, '每次循环必须喂上一次的结果');
    // auth = md5(f + key + String(rid) + String(ts))，ts 秒级、拼接顺序不能换
    assert.strictEqual(douyuApi.buildAuth('F', 'K', 9, 1700000000), nodeMd5('FK' + '9' + '1700000000'));
  });

  test('douyu/api: buildPlayUrl 参数齐全且 ver/iar 锁死（doc §1 一个字节都不能改）', () => {
    const enc = { did: 'a'.repeat(32), enc_data: 'x y/z', key: 'K', f: 'F' };
    const url = douyuApi.buildPlayUrl(9, 2, enc, 1700000000);
    assert.strictEqual(url.indexOf(douyuApi.DOUYU_HOST + '/lapi/live/getH5PlayV1/9?'), 0);
    const must = [
      'tt=1700000000',
      'auth=' + douyuApi.buildAuth('F', 'K', 9, 1700000000),
      'cdn=',
      'rate=2',
      'ver=Douyu_224011102',
      'iar=0',
      'ive=0',
      'prev=1',
      'bs=2'
    ];
    const query = url.slice(url.indexOf('?') + 1).split('&');
    for (const kv of must) assert.ok(query.indexOf(kv) >= 0, '缺参数 ' + kv);
    // did / enc_data 必须 encodeURIComponent（enc_data 里有空格与斜杠）
    assert.ok(query.indexOf('did=' + encodeURIComponent(enc.did)) >= 0);
    assert.ok(query.indexOf('enc_data=x%20y%2Fz') >= 0);
    // 硬约束：ver 与 iar 是签名之外的两个开关，改了就 403 或升档
    assert.strictEqual(douyuApi.PLAY_VER, 'Douyu_224011102');
    assert.strictEqual(douyuApi.DEFAULT_RATE, 2, 'doc §3：默认高清 900kbps');
  });

  test('douyu/api: normalizeRates 丢私有字段并跳过脏条目', () => {
    const out = douyuApi.normalizeRates([
      { name: '高清', rate: 2, bit: 900, diamondFan: 1, highBit: 4000 },
      { rate: 3, bit: 2000 },
      null,
      'x',
      { name: 'no-rate' }
    ]);
    assert.deepStrictEqual(out, [
      { name: '高清', rate: 2, bit: 900 },
      { name: 'rate3', rate: 3, bit: 2000 }
    ]);
    assert.deepStrictEqual(douyuApi.normalizeRates(null), []);
    assert.deepStrictEqual(douyuApi.normalizeRates('x'), []);
  });

  test('douyu/normalize: 条目归一（封面/头像档位、人气文案、未开播标记）', () => {
    const raw = {
      rid: 1863767,
      rn: '  王者荣耀  官方赛事 ',
      nn: '王者荣耀官方赛事',
      cid2: 181,
      c2name: '王者荣耀',
      ol: 536100,
      av: 'avatar_v3/202507/abc',
      rs16: 'https://rpic.douyucdn.cn/live-cover/roomCover/2025/08/01/x.jpg',
      rs1: 'https://rpic.douyucdn.cn/live-cover/roomCover/2025/08/01/x_big.jpg'
    };
    const it = douyuNorm.normalizeRoom(raw);
    assert.strictEqual(it.site, 'douyu');
    assert.strictEqual(it.rid, 1863767);
    assert.strictEqual(it.title, '王者荣耀 官方赛事', '多余空白压成一个空格');
    assert.strictEqual(it.streamer, '王者荣耀官方赛事');
    assert.strictEqual(it.category, '王者荣耀');
    assert.strictEqual(it.online, 536100);
    assert.strictEqual(it.onlineText, '53.6万');
    assert.strictEqual(it.isLive, true, '契约恒为 true');
    assert.strictEqual(it.offline, false);
    // 默认 rs16；显式 rs1 才用大图（400x400 方形，布局不能按 16:9 摆）
    assert.ok(it.cover.indexOf('/x.jpg') > 0, '默认 rs16：' + it.cover);
    assert.ok(douyuNorm.normalizeRoom(raw, { size: 'rs1' }).cover.indexOf('/x_big.jpg') > 0);
    // 图片协议一律降 http（设备 ImageLoader 基于 curl，没有 CA 库）
    assert.strictEqual(it.cover.indexOf('http://'), 0, it.cover);
    // 头像 av 是相对路径且无扩展名，必须按档位补后缀
    assert.strictEqual(it.avatar, 'http://apic.douyucdn.cn/upload/avatar_v3/202507/abc_middle.jpg');
    assert.ok(douyuNorm.normalizeAvatar('avatar_v3/x', 'big').indexOf('_big.jpg') > 0);
    assert.strictEqual(douyuNorm.normalizeAvatar(''), '');
    // 未开播：ol=0（实测这类房间取流必得 -15）
    const off = douyuNorm.normalizeRoom({ rid: 2, rn: 't', nn: 'n', ol: 0 });
    assert.strictEqual(off.offline, true);
    assert.strictEqual(off.onlineText, '');
    // rid 非法 → null，列表归一必须丢掉
    assert.strictEqual(douyuNorm.normalizeRoom({ rid: 0, rn: 't' }), null);
    assert.strictEqual(douyuNorm.normalizeRoom(null), null);
    const list = douyuNorm.normalizeRoomList([{ rid: 1, rn: 'a', nn: 'a', ol: 5 }, { rid: -1 }, { rid: 3, rn: 'b', nn: 'b', ol: 7 }]);
    assert.deepStrictEqual(list.map((x) => x.rid), [1, 3]);
    assert.deepStrictEqual(douyuNorm.normalizeRoomList(null), []);
  });

  test('douyu/feed: 列表 URL 分段与关键词过滤', () => {
    // 推荐恒走 0_0（实测 2_0 返回 code:0 + rl:[] 空列表）
    assert.strictEqual(
      douyuFeed.buildMixListUrl(0, 1),
      douyuApi.DOUYU_HOST + '/gapi/rkc/directory/mixList/0_0/1'
    );
    assert.strictEqual(
      douyuFeed.buildMixListUrl(181, 3),
      douyuApi.DOUYU_HOST + '/gapi/rkc/directory/mixList/2_181/3',
      'cid1 恒为 2'
    );
    assert.ok(douyuFeed.buildMixListUrl(181, 0).indexOf('/2_181/1') > 0, '页码钳到 1');
    assert.ok(douyuFeed.buildMixListUrl('x', 'y').indexOf('/0_0/1') > 0, '脏输入按推荐首页');
    // 关键词匹配标题或主播名，大小写不敏感
    const it = { title: 'Gemini：狼队 VS TTG', streamer: 'MrGemini' };
    assert.strictEqual(douyuFeed.matchKeyword(it, 'gemini'), true);
    assert.strictEqual(douyuFeed.matchKeyword(it, '狼队'), true);
    assert.strictEqual(douyuFeed.matchKeyword(it, '原神'), false);
    assert.strictEqual(douyuFeed.matchKeyword(null, 'x'), false);
    assert.strictEqual(douyuFeed.matchKeyword(it, ''), false);
  });

  test('douyu/cate: 分类树归一（cid2 保留 + 空分类剔除）', () => {
    const out = douyuCate.normalizeCategories({
      cateList: [
        { id: 4, cn1: '网游竞技', list: [{ cid1: 4, cid2: 1, cn2: '英雄联盟' }, { cid1: 4, cid2: 181, cn2: '王者荣耀' }] },
        { id: 9, cn1: '空分类', list: [] },
        null
      ]
    });
    assert.deepStrictEqual(out, [
      {
        id: 4,
        name: '网游竞技',
        subs: [
          { cid1: 4, cid2: 1, name: '英雄联盟' },
          { cid1: 4, cid2: 181, name: '王者荣耀' }
        ]
      }
    ]);
    assert.deepStrictEqual(douyuCate.normalizeCategories(null), []);
    assert.deepStrictEqual(douyuCate.normalizeCategories({ cateList: 'x' }), []);
    // 拼 URL 用的 cid1 与分类树里的 cid1 不是一回事，必须用常量 2
    assert.strictEqual(douyuCate.MIX_CID1, 2);
  });


  // ---------------- play_session（只播斗鱼直播） ----------------

  /* 页面 ctx 的最小假实现：只给 play_session 真正会读的字段。
   * 取流走 ctx.douyuFetchPlayInfo（可注入），**不联网**。 */

  function fakePlayDeps(overrides) {
    const calls = { open: [], pause: 0, resume: 0, seek: [], stop: 0, release: 0, status: 0 };
    const w = {
      calls: calls,
      player: {
        openSession: async (o) => {
          calls.open.push(o);
          return { ok: true, state: 'playing', outWidth: 254, outHeight: 452, fps: 30 };
        },
        pause: async () => {
          calls.pause++;
          return { ok: true, state: 'paused' };
        },
        resume: async () => {
          calls.resume++;
          return { ok: true, state: 'playing' };
        },
        seek: async (ms) => {
          calls.seek.push(ms);
          return { ok: true, positionMs: ms };
        },
        status: async () => {
          calls.status++;
          return { ok: true, state: 'playing', frames: 10 * calls.status, positionMs: 1000 * calls.status };
        },
        stop: async () => {
          calls.stop++;
          return { ok: true };
        },
        release: async () => {
          calls.release++;
          return { ok: true };
        }
      },
      douyuFetchPlayInfo: async (rid, rate) => ({
        ok: true,
        rid: rid,
        url: 'https://hwa.douyucdn2.cn/live/' + rid + '_900.flv?wsAuth=a&expire=0',
        rate: rate,
        rates: [{ name: '高清', rate: rate, bit: 900 }]
      }),
      mediaUa: TEST_UA,
      mediaReferer: TEST_REFERER,
      videoSettings: {},
      nowSec: () => 1700000000,
      nowMs: () => 1700000000000,
      log: null,
      cancelled: () => false
    };
    if (overrides) Object.assign(w, overrides);
    return w;
  }

  test('play_session: toggle 映射与失败透传', async () => {
    const w = fakePlayDeps();
    const a = await togglePlay(w, true); // playing → pause
    assert.strictEqual(a.state, 'paused');
    assert.strictEqual(w.calls.pause, 1);
    const b = await togglePlay(w, false);
    assert.strictEqual(b.state, 'playing');
    assert.strictEqual(w.calls.resume, 1);
    w.player.pause = async () => ({ ok: false, code: 'PLAYER_CALL_FAILED', error: 'x' });
    const c = await togglePlay(w, true);
    assert.strictEqual(c.ok, false);
    assert.ok(c.message.indexOf('PLAYER_CALL_FAILED') >= 0);
  });

  test('play_session: recoverSession 无 recover() → PLAYER_UNSUPPORTED（不抛）', async () => {
    const w = fakePlayDeps();
    const r = await recoverSession(w);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PLAYER_UNSUPPORTED');
  });

  test('play_session: recoverSession 有 recover() → 透传 ok/state', async () => {
    const w = fakePlayDeps();
    w.player.recover = async () => ({ ok: true, state: 'playing' });
    const r = await recoverSession(w);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.state, 'playing');
  });

  test('play_session: recoverSession recover() 抛错 → PLAYER_RECOVER_FAILED', async () => {
    const w = fakePlayDeps();
    w.player.recover = async () => {
      throw new Error('boom');
    };
    const r = await recoverSession(w);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PLAYER_RECOVER_FAILED');
    assert.strictEqual(r.message, 'boom');
  });

  test('play_session: readStatus 透传 player2 新字段（缺省给安全默认值）', async () => {
    const w = fakePlayDeps();
    // v2 全字段
    w.player.status = async () => ({
      ok: true,
      state: 'playing',
      frames: 5,
      positionMs: 100,
      durationMs: 206000,
      fps: 30,
      hasAudio: false,
      seekPending: true,
      seekTargetMs: 90000,
      planeActive: false,
      pipelineAlive: false,
      lastError: -5,
      lastErrorMsg: 'EOS'
    });
    const s = await readStatus(w);
    assert.strictEqual(s.planeActive, false);
    assert.strictEqual(s.pipelineAlive, false);
    assert.strictEqual(s.nativeDurationMs, 206000);
    assert.strictEqual(s.nativeFps, 30);
    assert.strictEqual(s.hasAudio, false);
    assert.strictEqual(s.lastError, -5);
    assert.strictEqual(s.lastErrorMsg, 'EOS');
    // v1（没有这些字段）→ 安全默认值，页面逻辑不会因为 undefined 走错分支
    w.player.status = async () => ({ ok: true, state: 'playing', frames: 5, positionMs: 100 });
    const v1 = await readStatus(w);
    assert.strictEqual(v1.planeActive, true, '缺省视为平面正常，不能误判成故障');
    assert.strictEqual(v1.pipelineAlive, true);
    assert.strictEqual(v1.hasAudio, true);
    assert.strictEqual(v1.nativeDurationMs, 0);
    assert.strictEqual(v1.nativeFps, 0);
    assert.strictEqual(v1.lastError, 0);
    assert.strictEqual(v1.lastErrorMsg, '');
  });

  test('play_session: readStatus 错误翻译 + closeSession 幂等连打', async () => {
    const w = fakePlayDeps();
    w.player.status = async () => ({
      ok: true,
      state: 'playing',
      frames: 10,
      audioBytes: 777,
      videoStallMs: 9001,
      gateWaitMs: 1500
    });
    const ok1 = await readStatus(w);
    assert.strictEqual(ok1.ok, true);
    assert.strictEqual(ok1.frames, 10);
    assert.strictEqual(ok1.audioBytes, 777);
    assert.strictEqual(ok1.videoStallMs, 9001, 'A/V 巡检字段透传');
    assert.strictEqual(ok1.gateWaitMs, 1500, '起播门时长透传');
    w.player.status = async () => ({ ok: true, state: 'error', error: 'HTTP error 403 Forbidden', frames: 0 });
    const bad = await readStatus(w);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.message.indexOf('403') >= 0);
    await closeSession(w);
    await closeSession(w);
    assert.strictEqual(w.calls.stop, 2);
    assert.strictEqual(w.calls.release, 2);
  });

  test('play_session: readStatus 透传 v2.1.0 强制重同步字段', async () => {
    const w = fakePlayDeps();
    w.player.status = async () => ({
      ok: true,
      state: 'playing',
      frames: 100,
      positionMs: 5000,
      avDriftMs: 900,
      resyncing: true,
      resyncCount: 3,
      avDriftNowMs: 812
    });
    const st = await readStatus(w);
    assert.strictEqual(st.resyncing, true, '重同步标志透传 → 页面显示"加载中…"');
    assert.strictEqual(st.resyncCount, 3);
    assert.strictEqual(st.avDriftNowMs, 812);
    // 缺省（老 native 无这些字段）→ false/0，页面不会误显示"加载中…"
    w.player.status = async () => ({ ok: true, state: 'playing', frames: 1 });
    const st2 = await readStatus(w);
    assert.strictEqual(st2.resyncing, false);
    assert.strictEqual(st2.resyncCount, 0);
  });

  test('play_session: describePlayError 阶段翻译 + 步长常量', () => {
    assert.ok(describePlayError({ ok: false, stage: 'playurl', message: 'x' }).indexOf('取流') >= 0);
    assert.ok(describePlayError({ ok: false, stage: 'transport', message: 'x' }).indexOf('网络') >= 0);
    assert.strictEqual(describePlayError({ ok: false, stage: 'offline', message: '主播未开播' }), '主播未开播');
    assert.strictEqual(describePlayError({ ok: false, stage: 'cancel', message: '已取消' }), '');
    assert.strictEqual(describePlayError({ ok: true }), '');
    assert.strictEqual(SEEK_STEP_MS, 20000);
  });

  /* ---------------- 直播直链 TTL / 主动换链（斗鱼 expire=300s） ----------------
   * 背景：斗鱼 getH5PlayV1 的 FLV 直链带 expire=300（5 分钟），签名绑了
   * (did, rid, ts, auth)。native 的断流重连用 open 时的原 URL，5 分钟后必然
   * 403 —— JS 必须提前换链。改后缀/续 query 都过不了签名（实测改 _900→_4000
   * 直接 403），只能重走 getEncryption → getH5PlayV1。 */

  test('play_session: LIVE_URL_TTL_MS / LIVE_URL_REFRESH_MS 常量（换链留足余量）', () => {
    assert.strictEqual(LIVE_URL_TTL_MS, 300000, '斗鱼 expire=300s');
    assert.strictEqual(LIVE_URL_REFRESH_MS, 210000, '提前 90s 换链');
    assert.ok(LIVE_URL_REFRESH_MS < LIVE_URL_TTL_MS, '换链阈值必须早于过期');
    assert.ok(LIVE_URL_TTL_MS - LIVE_URL_REFRESH_MS >= 60000,
      '余量要够走完两次签名请求 + 一次重试（实测单次 300~900ms，但 Wi-Fi 抖动远大于此）');
  });

  test('play_session: shouldRefreshLiveUrl 边界（纯函数，喂假 nowMs）', () => {
    const T0 = 1000000;
    // 非直播：点播的直链虽然也过期，但换链会打断播放位置 → 一律不换
    assert.strictEqual(shouldRefreshLiveUrl({ live: false, liveUrlAt: T0 }, T0 + 9e9), false);
    assert.strictEqual(shouldRefreshLiveUrl({ liveUrlAt: T0 }, T0 + 9e9), false, '缺 live 字段按非直播处理');
    // liveUrlAt=0 / 缺失 = 「不知道这条链什么时候拿的」→ 不主动换（否则一开播就白换）
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: 0 }, T0 + 9e9), false);
    assert.strictEqual(shouldRefreshLiveUrl({ live: true }, T0 + 9e9), false);
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: -1 }, T0 + 9e9), false);
    // 阈值边界：**刚好等于**阈值就换（>=，不是 >）——晚一步就可能正好过期
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: T0 }, T0 + LIVE_URL_REFRESH_MS - 1), false);
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: T0 }, T0 + LIVE_URL_REFRESH_MS), true);
    // 超过阈值
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: T0 }, T0 + LIVE_URL_REFRESH_MS + 1), true);
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: T0 }, T0 + LIVE_URL_TTL_MS), true);
    // 防御：坏参数不 throw
    assert.strictEqual(shouldRefreshLiveUrl(null, T0), false);
    assert.strictEqual(shouldRefreshLiveUrl(undefined, T0), false);
    assert.strictEqual(shouldRefreshLiveUrl('x', T0), false);
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: T0 }, NaN), false);
    assert.strictEqual(shouldRefreshLiveUrl({ live: true, liveUrlAt: T0 }, undefined), false);
  });

  test('play_session: 斗鱼 item 走 douyu 取流分支（只认 ctx.douyuFetchPlayInfo）', async () => {
    const seen = [];
    const ctx = {
      // 取流以外的接口一律不该被碰：塞个必定爆炸的假 client 作哨兵
      client: { request: async () => { throw new Error('不应调用取流以外的接口'); } },
      videoSettings: {},
      nowMs: () => 1700000000000,
      douyuFetchPlayInfo: async (rid, rate) => {
        seen.push([rid, rate]);
        return {
          ok: true,
          rid: rid,
          url: 'https://hwa.douyucdn2.cn/live/9_900.flv?wsAuth=a&expire=0',
          rate: 2,
          rates: [{ name: '高清', rate: 2, bit: 900 }]
        };
      }
    };
    const r = await resolveLiveUrl(ctx, { site: 'douyu', rid: 9, title: '斗鱼标题' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.live, true);
    assert.strictEqual(r.site, 'douyu');
    assert.strictEqual(r.audioUrl, '', 'FLV 自带音轨：回填会开第二条连接');
    assert.strictEqual(r.durationMs, 0);
    assert.strictEqual(r.roomid, 9);
    assert.strictEqual(r.qn, 2, 'qn 用服务端实际档位');
    assert.deepStrictEqual(seen, [[9, 2]], '未指定 ctx.douyuRate → 默认 rate=2（doc §3）');
    assert.strictEqual(r.liveUrlAt, 1700000000000, 'liveUrlAt 必须来自 ctx.nowMs（可测）');
    // 房间号非法 → param，不发请求
    assert.strictEqual((await resolveLiveUrl(ctx, { site: 'douyu', rid: 0 })).stage, 'param');
    // -15 = 未开播 → stage=offline（页面据此显示「主播未开播」而不是「取流失败」）
    const off = await resolveLiveUrl(
      Object.assign({}, ctx, { douyuFetchPlayInfo: async () => ({ ok: false, error: -15, errorText: '非法请求' }) }),
      { site: 'douyu', rid: 9 }
    );
    assert.strictEqual(off.ok, false);
    assert.strictEqual(off.stage, 'offline');
    assert.ok(describePlayError(off).length > 0);
    // 其它错误 → playurl
    const bad = await resolveLiveUrl(
      Object.assign({}, ctx, { douyuFetchPlayInfo: async () => ({ ok: false, error: 'AUTH_REJECTED', errorText: '签名被拒(403)' }) }),
      { site: 'douyu', rid: 9 }
    );
    assert.strictEqual(bad.stage, 'playurl');
    assert.strictEqual(bad.code, 'AUTH_REJECTED');
  });

  test('play_session: openVideo 直播透传 liveUrlAt / site / rates', async () => {
    const w = fakePlayDeps({
      nowMs: () => 1700000000123,
      douyuFetchPlayInfo: async () => ({
        ok: true,
        url: 'https://hwa.douyucdn2.cn/live/9_900.flv?wsAuth=a',
        rate: 0, // 服务端把 rate=2 降成了原画（实测行为）
        rates: [{ name: '原画', rate: 0, bit: 10000 }]
      })
    });
    const r = await openVideo(w, { site: 'douyu', rid: 9, title: 'T' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.session.live, true);
    assert.strictEqual(r.session.kind, 'live');
    assert.strictEqual(r.session.site, 'douyu');
    assert.strictEqual(r.session.liveUrlAt, 1700000000123, 'liveUrlAt 必须透传到 session');
    assert.strictEqual(r.session.qn, 0, '以服务端实际档位为准，不用请求的 2');
    assert.strictEqual(r.session.douyuRate, 2, '换链要沿用**请求的**档位');
    assert.strictEqual(r.session.rates.length, 1);
    assert.strictEqual(w.calls.open[0].isLive, true, 'native 必须收到 live=1（否则走 ffmpeg 路径）');
    assert.strictEqual(w.calls.open[0].input2, '', '单输入直连');
    // 纯直播客户端：每次 openVideo 都产出直播 session，liveUrlAt 恒为本次取流时刻
    assert.strictEqual(typeof r.session.roomid, 'number');
  });

  test('play_session: refreshLiveUrl 斗鱼 —— 重新签名取新链（绝不改后缀）', async () => {
    const seen = [];
    let n = 0;
    const ctx = {
      nowMs: () => 1700000300000,
      douyuFetchPlayInfo: async (rid, rate) => {
        seen.push([rid, rate]);
        n++;
        // 每次调用都是一条全新的 wsAuth/token（服务端按 ts 签名）
        return {
          ok: true,
          url: 'https://hwa.douyucdn2.cn/live/' + rid + '_900.flv?wsAuth=sig' + n,
          rate: 2,
          rates: [{ name: '高清', rate: 2, bit: 900 }]
        };
      }
    };
    const session = { live: true, site: 'douyu', roomid: 9, douyuRate: 3, liveUrlAt: 1700000000000 };
    assert.strictEqual(shouldRefreshLiveUrl(session, 1700000300000), true, '前置：确实到换链点了');
    const r = await refreshLiveUrl(ctx, session);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'https://hwa.douyucdn2.cn/live/9_900.flv?wsAuth=sig1');
    assert.strictEqual(r.liveUrlAt, 1700000300000, '新链的取得时刻 = 现在');
    assert.strictEqual(r.qn, 2);
    assert.deepStrictEqual(seen, [[9, 3]], '沿用 session.douyuRate 重新签名，不是改 URL 后缀');
    // 换完链 → shouldRefreshLiveUrl 立刻变 false（否则轮询会疯狂重取）
    const next = { live: true, site: 'douyu', liveUrlAt: r.liveUrlAt };
    assert.strictEqual(shouldRefreshLiveUrl(next, 1700000300000), false);
    // opts.rate 可覆盖（用户切档）
    const r2 = await refreshLiveUrl(ctx, session, { rate: 0, nowMs: 1800000000000 });
    assert.deepStrictEqual(seen[1], [9, 0]);
    assert.strictEqual(r2.liveUrlAt, 1800000000000);
    // 失败：未开播 / 网络 —— 都返回结构化错误，不 throw
    const off = await refreshLiveUrl(
      Object.assign({}, ctx, { douyuFetchPlayInfo: async () => ({ ok: false, error: -15, errorText: '非法请求' }) }),
      session
    );
    assert.strictEqual(off.ok, false);
    assert.strictEqual(off.stage, 'offline');
    const net = await refreshLiveUrl(
      Object.assign({}, ctx, { douyuFetchPlayInfo: async () => ({ ok: false, error: 'NETWORK', errorText: 'curl: (6) 域名解析失败' }) }),
      session
    );
    assert.strictEqual(net.ok, false);
    assert.strictEqual(net.stage, 'playurl');
    assert.ok(net.message.length > 0);
    // 参数防御
    assert.strictEqual((await refreshLiveUrl(ctx, null)).stage, 'param');
    assert.strictEqual((await refreshLiveUrl(ctx, { live: false, roomid: 9 })).stage, 'param', '点播不换链');
    assert.strictEqual((await refreshLiveUrl(ctx, { live: true, site: 'douyu' })).stage, 'param', '缺房间号');
    // 取消标志
    const canc = await refreshLiveUrl(
      Object.assign({}, ctx, { cancelled: () => true }),
      session
    );
    assert.strictEqual(canc.stage, 'cancel');
  });

  /* ---------------- native 数值归一化（review2 审计 P0-1） ----------------
   * 核心回归点：native 的"未测到"哨兵 **-1** 必须被归一回 0。
   * 旧写法 `Number(-1) || 0` 会漏掉 -1（-1 是真值），导致看门狗的
   * `videoStallMs > 8000` 恒 false → 永不触发 → 界面永久「加载中…」。 */

  test('play_session: num() 把 -1 哨兵/NaN/undefined 归一到默认值', () => {
    assert.strictEqual(num(-1, 0), 0, 'native 的 -1 哨兵必须归一成 0');
    assert.strictEqual(num(-1, 7), 7, '负数一律用默认值');
    assert.strictEqual(num(undefined, 0), 0);
    assert.strictEqual(num(null, 0), 0);
    assert.strictEqual(num('', 0), 0);
    assert.strictEqual(num(NaN, 0), 0);
    assert.strictEqual(num(Infinity, 0), 0);
    assert.strictEqual(num({}, 0), 0, '非 number 类型不接受');
    assert.strictEqual(num(true, 0), 0, 'bool 不能当数字用');
    assert.strictEqual(num(0, 9), 0, '0 是合法值，不能被默认值顶掉');
    assert.strictEqual(num(9001, 0), 9001, '真正的停帧时长要原样透传');
    assert.strictEqual(num('123', 0), 123, '字符串数字要接受（QuickJS 桥有时给字符串）');
    assert.strictEqual(num(9001), 9001, '不传默认值 = 0');
    assert.strictEqual(num(-1), 0);
  });

  test('play_session: numSigned() 保留负号 / numLatency() 保留 -1 语义', () => {
    // 诊断量：负数有意义（声音滞后、ALSA 缓冲修正、native errno）
    assert.strictEqual(numSigned(-812, 0), -812);
    assert.strictEqual(numSigned(-5, 0), -5, 'lastError 见过 -5(EIO)，必须保负');
    assert.strictEqual(numSigned(undefined, 0), 0);
    assert.strictEqual(numSigned(NaN, 0), 0);
    assert.strictEqual(numSigned('12', 0), 12);
    // 音画起播差：-1 = 未测到，页面用 >= 0 判"测到了"，绝不能归一成 0（否则会被当成功）
    assert.strictEqual(numLatency(-1), -1);
    assert.strictEqual(numLatency(undefined), -1, '缺失同样返回 -1 而不是 0');
    assert.strictEqual(numLatency(null), -1);
    assert.strictEqual(numLatency(''), -1);
    assert.strictEqual(numLatency(NaN), -1);
    assert.strictEqual(numLatency(0), 0, '0ms 是真实的"完全同步"');
    assert.strictEqual(numLatency(1200), 1200);
  });

  test('play_session: readStatus 归一化 videoStallMs/positionMs/frames 并把未知 state 落 error', async () => {
    const w = fakePlayDeps();
    // 起播阶段（从未出过帧）：native 返回哨兵 -1 + 负数位置
    w.player.status = async () => ({
      ok: true,
      state: 'opening',
      frames: -1,
      positionMs: -1,
      audioBytes: -1,
      videoStallMs: -1,
      gateWaitMs: -1,
      resyncingMs: -1,
      seekTargetMs: -1,
      durationMs: -1,
      fps: -1
    });
    const st = await readStatus(w);
    assert.strictEqual(st.state, 'opening');
    assert.strictEqual(st.videoStallMs, 0, '-1 哨兵归一到 0（否则看门狗 >8000 永不触发）');
    assert.strictEqual(st.frames, 0);
    assert.strictEqual(st.positionMs, 0);
    assert.strictEqual(st.audioBytes, 0);
    assert.strictEqual(st.gateWaitMs, 0);
    assert.strictEqual(st.resyncingMs, 0);
    assert.strictEqual(st.nativeDurationMs, 0);
    assert.strictEqual(st.nativeFps, 0);
    // 真正的停帧要原样透传（归一化不能把真实故障吃掉）
    w.player.status = async () => ({ ok: true, state: 'playing', frames: 10, videoStallMs: 9001 });
    const st2 = await readStatus(w);
    assert.strictEqual(st2.videoStallMs, 9001);
    // 未知 state → 'error' + 一条 warn（避免界面卡在谁都分支不到的状态上）
    const logs = [];
    w.log = (m) => logs.push(m);
    w.player.status = async () => ({ ok: true, state: 'bogus', frames: 10 });
    const st3 = await readStatus(w);
    assert.strictEqual(st3.state, 'error');
    assert.ok(logs.some((m) => m.indexOf('未识别的播放器状态') >= 0), '未知态要留日志证据');
    // stopped 是 stop() 之后的正常态 → 归一到 idle，不能当故障
    w.player.status = async () => ({ ok: true, state: 'stopped', frames: 0 });
    const st4 = await readStatus(w);
    assert.strictEqual(st4.state, 'idle');
  });

  test('play_session: normalizeState 白名单（含 stopped→idle）', () => {
    assert.strictEqual(normalizeState('playing'), 'playing');
    assert.strictEqual(normalizeState('paused'), 'paused');
    assert.strictEqual(normalizeState('seeking'), 'seeking');
    assert.strictEqual(normalizeState('ended'), 'ended');
    assert.strictEqual(normalizeState('error'), 'error');
    assert.strictEqual(normalizeState('stopped'), 'idle');
    assert.strictEqual(normalizeState('opening'), 'opening');
    assert.strictEqual(normalizeState('idle'), 'idle');
    assert.strictEqual(normalizeState(undefined), 'error');
    assert.strictEqual(normalizeState(null), 'error');
    assert.strictEqual(normalizeState(0), 'error');
    assert.strictEqual(normalizeState('PLAYING'), 'error', '大小写敏感：不猜');
  });

  test('play_session: isLiveEnded 主播下播（state 落回 idle）判直播已结束', () => {
    /* 真机契约：直播 EOS → native patch_state(STOPPED) → normalizeState 归一成
     * 'idle'，而页面只认 'ended' → 提示永远不出来（P1-4）。isLiveEnded 必须
     * 认 'idle'。 */
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 600000, frames: 900 }, true, true), true);
    // 将来 native 真加了 PB2_STATE_ENDED 也能直通
    assert.strictEqual(isLiveEnded({ state: 'ended', positionMs: 600000, frames: 900 }, true, true), true);
    /* 没观察到过 playing（轮询 1s 一次，刚进页面就下播会漏）：用「出过帧」兜底 */
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 3000, frames: 12 }, true, false), true);
    /* ★ 反例：位置非 0 但一帧都没出过 —— **不能**当证据。直播位置=墙钟，
     * 从 open 就开始走，一进页面就 +1000/秒。若拿它当判据，用户刚点进直播间
     * 就会看到「直播已结束」。 */
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 3000, frames: 0 }, true, false), false);
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 600000, frames: 0 }, true, false), false);
  });

  test('play_session: isLiveEnded 不误判「刚进页面还没起播」/ 点播 / 仍在播', () => {
    /* ★ 这是 lead 点名的核心边界：刚进直播间时 state 也是 idle/opening、
     * 位置 0、没出过帧 —— 绝不能判成「已结束」，否则用户一进去就看到
     * 「直播已结束」。 */
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 0, frames: 0 }, true, false), false);
    assert.strictEqual(isLiveEnded({ state: 'opening', positionMs: 0, frames: 0 }, true, false), false);
    // 起播中（opening）即使有位置也不该判结束 —— state 不是 idle/ended
    assert.strictEqual(isLiveEnded({ state: 'opening', positionMs: 3000, frames: 5 }, true, true), false);
    // 还在正常播 → false
    assert.strictEqual(isLiveEnded({ state: 'playing', positionMs: 600000, frames: 900 }, true, true), false);
    // 暂停（直播暂停）→ false，不算结束
    assert.strictEqual(isLiveEnded({ state: 'paused', positionMs: 600000, frames: 900 }, true, true), false);
    // 真错误态交给页面失败路径，不走「已结束」
    assert.strictEqual(isLiveEnded({ state: 'error', positionMs: 600000, frames: 900 }, true, true), false);
    /* ★ 点播绝不能被这个函数判走：live !== true 一律 false（点播末尾走
     * isStreamEnded，两者职责分离）。 */
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 114879, frames: 900 }, false, true), false);
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 114879, frames: 900 }, undefined, true), false);
    assert.strictEqual(isLiveEnded({ state: 'idle', positionMs: 114879, frames: 900 }, null, true), false);
    // 脏输入不崩
    assert.strictEqual(isLiveEnded(null, true, true), false);
    assert.strictEqual(isLiveEnded(undefined, true, true), false);
    assert.strictEqual(isLiveEnded('x', true, true), false);
    assert.strictEqual(isLiveEnded({}, true, true), false);
  });

  test('play_session: isLiveReconnecting 只认直播 + 码 17（且不抢真错误态）', () => {
    /* 与 native2 对齐的码值锁死：core/queue.h 已占用 0..16，17 是下一个空位。 */
    assert.strictEqual(LIVE_RECONNECT_ERR, 17);
    // 直播 + 码 17 + state 仍是 playing（native2 不改 state）→ 正在重连
    assert.strictEqual(
      isLiveReconnecting({ state: 'playing', lastError: 17, lastErrorMsg: 'live reconnect' }, true),
      true
    );
    // 码 17 但缺 msg 也要认（判据以码为准）
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 17 }, true), true);
    // 字符串形态的码（JSAPI 有时给字符串）
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: '17' }, true), true);
    /* 真错误态（state === 'error'）不归这里管：页面已有「起播失败」路径，
     * 重连提示不能覆盖它。 */
    assert.strictEqual(isLiveReconnecting({ state: 'error', lastError: 17 }, true), false);
    // 点播即使 lastError=17 也不提示（17 是直播专用码）
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 17 }, false), false);
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 17 }, undefined), false);
    // 其它错误码不误判（12=PLANE_LOST，真机上键盘避让时会出现）
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 12 }, true), false);
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 0 }, true), false);
    assert.strictEqual(isLiveReconnecting({ state: 'playing' }, true), false);
    // 脏输入不崩
    assert.strictEqual(isLiveReconnecting(null, true), false);
    assert.strictEqual(isLiveReconnecting('x', true), false);
  });

  test('play_session: isLiveReconnecting 的 lastErrorMsg 兜底（native 换码也能提示）', () => {
    /* 万一 native2 最终没用 17（比如换了码值），只要 msg 里带 reconnect 就仍提示 ——
     * 这条兜底让「用户至少能看到点什么」不依赖单个魔法数字。 */
    assert.strictEqual(
      isLiveReconnecting({ state: 'playing', lastError: 99, lastErrorMsg: 'live reconnect attempt 2' }, true),
      true
    );
    assert.strictEqual(
      isLiveReconnecting({ state: 'playing', lastError: 0, lastErrorMsg: 'RECONNECTING' }, true),
      true
    );
    // 不含 reconnect 的普通错误不改提示
    assert.strictEqual(
      isLiveReconnecting({ state: 'playing', lastError: 95, lastErrorMsg: 'kms plane not active' }, true),
      false
    );
    // 空/非字符串 msg 不崩
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 17, lastErrorMsg: null }, true), true);
    assert.strictEqual(isLiveReconnecting({ state: 'playing', lastError: 0, lastErrorMsg: 42 }, true), false);
  });

  test('play_session: readStatus 同时给出 durationMs 与 nativeDurationMs（n10 别名）', async () => {
    const w = fakePlayDeps();
    w.player.status = async () => ({ ok: true, state: 'playing', durationMs: 114900, positionMs: 5000 });
    const st = await readStatus(w);
    /* 页面 tryRecover 读的是 st.durationMs（不是 nativeDurationMs）→ 以前恒 0 →
     * seekBy 不设上界 → 末尾还能往前 seek。两个字段必须同值。 */
    assert.strictEqual(st.durationMs, 114900);
    assert.strictEqual(st.nativeDurationMs, 114900);
    // 缺字段的老 native → 两个都 0
    w.player.status = async () => ({ ok: true, state: 'playing', positionMs: 5000 });
    const st2 = await readStatus(w);
    assert.strictEqual(st2.durationMs, 0);
    assert.strictEqual(st2.nativeDurationMs, 0);
  });

  test('live_end_probe: 用例表在 Node 下全部通过（与真机自证同源）', async () => {
    /* 这条测试与真机上的 probeLiveEnd 走**同一张用例表、同一个函数**：
     * 真机跑 QuickJS、这里跑 V8，两边都 PASS 才能说明判据不依赖引擎特性。
     * 一旦真机日志出现 LIVE-END PROBE FAIL，就能定位到具体哪条用例。 */
    const r = runLiveEndCases();
    /* 失败时把失败行拼进断言消息，不用去翻日志就知道哪条挂了 */
    assert.strictEqual(r.fail, 0, '失败用例: ' + r.failures.join(' | '));
    assert.ok(r.pass > 0, '用例表不能为空');
    assert.strictEqual(r.pass + r.fail, LIVE_END_CASES.length);
    /* 每条用例都必须带 name/kind/want 与「为什么」—— 否则真机日志里的 FAIL 行无法定位 */
    for (const c of LIVE_END_CASES) {
      assert.ok(typeof c.name === 'string' && c.name.length > 0, '用例缺 name');
      assert.ok(c.kind === 'end' || c.kind === 'reconnect', '用例 kind 非法: ' + c.kind);
      assert.strictEqual(typeof c.want, 'boolean');
      assert.ok(typeof c.why === 'string' && c.why.length > 0, '用例缺 why: ' + c.name);
    }
    /* 结果行里必须打出引擎指纹：真机与 Node 行为不一致时，
     * 第一件要看的就是它（历史上踩过 Number(undefined) 一类坑）。 */
    assert.ok(r.lines[0].indexOf('LIVE-END PROBE engine') >= 0);
    assert.ok(r.lines[0].indexOf("Number('17')=17") >= 0, '引擎指纹应包含 Number(17)');
    assert.ok(r.lines[r.lines.length - 1].indexOf('passed=') >= 0);
  });

  test('live_end_probe: 用例覆盖面涵盖墙钟/刚进直播间两个关键反例', () => {
    /* 防「用例被删了也不知道」：这两条反例直接对应真机上踩过的两个 bug
     * （刚进直播间误判已结束、墙钟位置当「播过」证据），丢了就会回退。 */
    const names = LIVE_END_CASES.map((c) => c.name).join('|');
    assert.ok(names.indexOf('墙钟') >= 0, '缺「墙钟位置不能当证据」反例');
    assert.ok(names.indexOf('刚进页面未起播') >= 0, '缺「刚进直播间」反例');
    const endN = LIVE_END_CASES.filter((c) => c.kind === 'end').length;
    const recN = LIVE_END_CASES.filter((c) => c.kind === 'reconnect').length;
    assert.ok(endN >= 8, '下播判据用例过少：' + endN);
    assert.ok(recN >= 5, '重连判据用例过少：' + recN);
    /* end 类用例必须都显式给 live（否则测的是其它东西） */
    let missingLive = 0;
    for (const c of LIVE_END_CASES) {
      if (c.kind === 'end' && !('live' in c)) missingLive++;
    }
    assert.strictEqual(missingLive, 0, '有 ' + missingLive + ' 条 end 用例没给 live 参数');
  });

  // ---------------- 主页网格：加载更多后必须整行（用户要求 m11950-3）----------------

  test('screen: trimToGridRows 尾部裁到列数整数倍', () => {
    assert.strictEqual(GRID_COLS, 5);
    // 12 → 10（裁 2）；15 不变；0/1/4 全裁掉
    assert.deepStrictEqual(trimToGridRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], GRID_COLS), {
      items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      trimmed: 2
    });
    const full = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    assert.deepStrictEqual(trimToGridRows(full, GRID_COLS), { items: full, trimmed: 0 });
    assert.deepStrictEqual(trimToGridRows([1, 2, 3, 4], GRID_COLS), { items: [], trimmed: 4 });
    assert.deepStrictEqual(trimToGridRows([], GRID_COLS), { items: [], trimmed: 0 });
    // 非数组 / 非法列数都不抛
    assert.deepStrictEqual(trimToGridRows(null, GRID_COLS), { items: [], trimmed: 0 });
    assert.deepStrictEqual(trimToGridRows([1, 2, 3, 4, 5, 6], 0).items.length, 5);
  });

  // ---------------- 播放几何（213 + 469 + 278 = 960，用户手绘稿 m11950）----------------

  test('screen: playVideoRects 16:9 居中，物理 {0,299,240,427}（真·旋转变换）', () => {
    const r = playVideoRects(640, 360);
    assert.deepStrictEqual(r.logical, { x: 234, y: 0, width: 427, height: 240 });
    assert.deepStrictEqual(r.physical, { x: 0, y: 299, width: 240, height: 427 });
    assert.strictEqual(BAR_WIDTH, 76);
    assert.strictEqual(BAR_WIDTH + r.logical.width + BAR_WIDTH, 579); // 16:9 只占 427
  });

  test('screen: 竖屏 playVideoRects → 物理竖柱（9:16 不变形）', () => {
    const r = playVideoRects(360, 640);
    assert.deepStrictEqual(r.logical, { x: 380, y: 0, width: 135, height: 240 });
    assert.deepStrictEqual(r.physical, { x: 0, y: 445, width: 240, height: 135 });
    // 比例守恒：物理 {w:240,h:135} 是逻辑 {w:135,h:240} 的转置 → h/w = 135/240 ≈ 1080/1920
    const src = 1080 / 1920;
    const out = r.physical.height / r.physical.width;
    assert.ok(Math.abs(out - src) < 0.02, 'src=' + src + ' out=' + out);
    assert.ok(isRectInsidePanel(r.physical));
  });

  test('screen: 宽比例视频必须信箱进视频区 469x240（越区溢出回归防护）', () => {
    // 历史 bug（X5 800x254）：fit box=全屏 → 比 16:9 更宽的视频按高适配得 w>列宽 →
    // 画面溢出到左栏按钮与右栏评论区（真机实测）。
    // X6 Pro 视频区逻辑 {x:64,y:0,w:448,h:240}，下方 y∈[240,266) 是进度条（26px）。
    const cases = [
      [1920, 1080], // 16:9 回归
      [1920, 800], // 2.4:1
      [1920, 817], // 2.35:1 宽银幕
      [2560, 1080], // 21:9
      [3440, 1440], // 带鱼屏
      [3840, 1080], // 32:9 极宽
      [1000, 1000] // 1:1
    ];
    for (const c of cases) {
      const r = playVideoRects(c[0], c[1]);
      const tag = c.join('x');
      const g = r.logical;
      // 1) 逻辑面必须整块落在视频区内（左右不出区、上下不出 240 高）
      assert.ok(g.x >= VIDEO_AREA.x, tag + ' 逻辑 x 越出视频区首: ' + g.x);
      assert.ok(g.x + g.width <= VIDEO_AREA.x + VIDEO_AREA.width, tag + ' 逻辑 x 越出视频区尾');
      assert.ok(g.y >= VIDEO_AREA.y, tag + ' 逻辑 y 越出视频区首: ' + g.y);
      assert.ok(g.y + g.height <= VIDEO_AREA.y + VIDEO_AREA.height, tag + ' 逻辑 y 压到进度条');
      // 2) 物理面必须落在面板的 266 宽列内（native 再加 PANEL_X_OFFSET=107）
      const p = r.physical;
      assert.ok(isRectInsidePanel(p), tag + ' 不在面板内');
      assert.ok(p.x >= 0 && p.x + p.width <= PHYSICAL.width, tag + ' 物理 x 越出列');
      // 3) **进度条安全**：进度条逻辑 y∈[240,266) → 物理 x∈[240,266)。
      //    视频物理 x 是逻辑 y 的直映，故 x+width 必须 <= 240。
      assert.ok(
        p.x + p.width <= VIDEO_AREA.height,
        tag + ' 压住进度条: 物理 x+w=' + (p.x + p.width) + ' > ' + VIDEO_AREA.height
      );
      // 4) 比例守恒（物理是逻辑的转置，宽高互换）
      const src = c[0] / c[1];
      const out = p.height / p.width;
      assert.ok(Math.abs(out - src) / src < 0.02, tag + ' 变形: src=' + src + ' out=' + out);
    }
  });

  // ---------------- 直播视频区（无进度条，469x266）----------------

  // 用户反馈 m07570-3：「直播界面不应该出现进度条」。进度条那条 26px 让给画面后，

  // KMS 平面的逻辑矩形也必须从 240 高变成 266 高，否则画面下方会留一条黑边，

  // 而 hole 的点击热区是 266 —— 用户点黑边能暂停、看着却像没画面。

  test('screen: LIVE_VIDEO_AREA 比点播高 26px（让出进度条那条）', () => {
    assert.strictEqual(LIVE_VIDEO_AREA.height, 266);
    assert.strictEqual(VIDEO_AREA.height, 240);
    assert.strictEqual(LIVE_VIDEO_AREA.height - VIDEO_AREA.height, 26);
    assert.strictEqual(LIVE_VIDEO_AREA.x, VIDEO_AREA.x);
    assert.strictEqual(LIVE_VIDEO_AREA.width, VIDEO_AREA.width);
  });

  test('screen: 直播 playVideoRects 16:9 → 逻辑 469x264、物理 {1,278,264,469}', () => {
    const live = playVideoRects(1920, 1080, LIVE_VIDEO_AREA);
    assert.deepStrictEqual(live.logical, { x: 213, y: 1, width: 469, height: 264 });
    assert.deepStrictEqual(live.physical, { x: 1, y: 278, width: 264, height: 469 });
    // 点播同源视频仍是 240 高（回归防护：不能把默认 box 也改了）
    const vod = playVideoRects(1920, 1080);
    assert.deepStrictEqual(vod.logical, { x: 234, y: 0, width: 427, height: 240 });
    assert.deepStrictEqual(vod.physical, { x: 0, y: 299, width: 240, height: 427 });
  });

  test('screen: 直播矩形填满 266 列且不越出 LIVE_VIDEO_AREA（各比例）', () => {
    const cases = [
      [1920, 1080], // 16:9
      [1280, 720], // 16:9
      [2560, 1080], // 21:9
      [3840, 1080], // 32:9 极宽
      [1000, 1000], // 1:1
      [1080, 1920] // 9:16 竖屏
    ];
    for (const c of cases) {
      const tag = c.join('x');
      const r = playVideoRects(c[0], c[1], LIVE_VIDEO_AREA);
      const g = r.logical;
      assert.ok(g.x >= LIVE_VIDEO_AREA.x, tag + ' 逻辑 x 越出视频区首: ' + g.x);
      assert.ok(g.x + g.width <= LIVE_VIDEO_AREA.x + LIVE_VIDEO_AREA.width, tag + ' 逻辑 x 越出视频区尾');
      assert.ok(g.y >= LIVE_VIDEO_AREA.y, tag + ' 逻辑 y 越出视频区首: ' + g.y);
      assert.ok(
        g.y + g.height <= LIVE_VIDEO_AREA.y + LIVE_VIDEO_AREA.height,
        tag + ' 逻辑 y 越出 266 视频区: ' + (g.y + g.height)
      );
      // 直播没有进度条，物理 x 可以一直顶到 266（点播被限制在 240）
      const p = r.physical;
      assert.ok(isRectInsidePanel(p), tag + ' 不在面板内');
      assert.ok(p.x >= 0 && p.x + p.width <= PHYSICAL.width, tag + ' 物理 x 越出列');
      assert.ok(p.x + p.width <= LIVE_VIDEO_AREA.height, tag + ' 物理 x 越出 266 视频区');
      // 比例守恒
      const src = c[0] / c[1];
      const out = p.height / p.width;
      assert.ok(Math.abs(out - src) / src < 0.02, tag + ' 变形: src=' + src + ' out=' + out);
    }
  });

  test('screen: playVideoRects 第二参缺省/传 null 时仍走点播 240 高（向后兼容）', () => {
    const a = playVideoRects(640, 360);
    assert.deepStrictEqual(playVideoRects(640, 360, null), a);
    assert.deepStrictEqual(playVideoRects(640, 360, undefined), a);
  });

  // ---------------- native 管线源码契约（player.c 是 C，单测只能查文本） ----------------

  // 这几条防的都是「改了不报错、真机上画面直接没了」的静默故障。
  const csrc = fsx.readFileSync(pathx.join(__dirname, '..', 'native', 'csrc', 'player.c'), 'utf8');

  test('native: 面板率常量是 1497/25（59.88Hz），不能写成 60/1', () => {
    // 面板实测 59.88Hz（modetest -c: #0 480x960 59.88）。写 60/1 会差 0.2%，
    // 长跑里每 ~8s 多出一帧，表现为周期性错拍。
    assert.ok(/PENDOUYU_PANEL_RATE\s+"1497\/25"/.test(csrc), 'PENDOUYU_PANEL_RATE 必须是 "1497/25"');
    assert.ok(!/PENDOUYU_PANEL_RATE\s+"60\/1"/.test(csrc), '不能退化成 60/1');
  });

  test('native: caps 必须是一个 argv（拆开会拼出非法 caps）', () => {
    // 历史 bug：写成 argv "video/x-raw" + "framerate=1497/25" 两个元素，
    // gst-launch 用空格拼成 `video/x-raw framerate=1497/25`，
    // caps 语法要求逗号 → `could not parse caps`，整条管线不建，
    // 真机表现是「日志里 erroneous pipeline、屏幕停在上一帧」。
    assert.ok(
      /argv\[i\+\+\] = \(char \*\)"video\/x-raw,framerate=" PENDOUYU_PANEL_RATE;/.test(csrc),
      'framerate caps 必须与 video/x-raw 拼在同一个字符串里'
    );
    assert.ok(
      !/argv\[i\+\+\] = \(char \*\)"video\/x-raw";[\s\S]{0,200}argv\[i\+\+\] = \(char \*\)"framerate=/.test(
        csrc
      ),
      '不允许把 video/x-raw 与 framerate= 拆成两个 argv'
    );
  });

  test('native: kmssink 两条分支都带 skip-vsync=true', () => {
    // 原子驱动下 kmssink 的 vsync 等待是双份的，60fps 内容只跑到 57.45fps
    // （8s 素材耗时 8747ms；加 skip-vsync 后 8410ms / 60.19fps）。
    // fpsdisplaysink 分支（取证用）和直连 kmssink 分支必须一致，否则
    // 「开着诊断就流畅、关掉就卡」这种幽灵问题会回来。
    const n = (csrc.match(/skip-vsync=true/g) || []).length;
    assert.ok(n >= 2, 'skip-vsync=true 应出现 >= 2 次（fps 诊断分支 + 正常分支），实际 ' + n);
  });

  test('native: 归一化有排查开关，且默认开启', () => {
    // /tmp/vp_nonorm.on 存在 → 跳过 videorate 归一（对照旧行为）。
    // 判据取反：`access(...) != 0` 才是「默认开启」。
    assert.ok(
      /access\("\/tmp\/vp_nonorm\.on", F_OK\) != 0/.test(csrc),
      '归一化开关必须是 != 0（默认开启）'
    );
  });

  test('native: fps 解析必须吞掉小数点（29.97 不能变成 97）', () => {
    // 真机致命 bug（2026-10-31）：parse_fps_line 只向前扫数字，遇到 '.' 就停，
    // 于是 `29.97 fps` 被解析成 **97**。节拍器按 97fps 排程（10.3ms/帧）喂 30fps
    // 内容 → 画面 3.2 倍速快放，drift 飙到十几秒、skip 每秒几十次。
    // 凡是 29.97 / 59.94 的源全中招（直播 FLV 常见 29.97 帧）。
    assert.ok(
      /q\[-1\] >= '0' && q\[-1\] <= '9'\) \|\| q\[-1\] == '\.'/.test(csrc) ||
        /\|\| q\[-1\] == '\.'/.test(csrc),
      "向前扫描必须包含 '.' 分支"
    );
    assert.ok(
      /double fv = atof\(q\)/.test(csrc),
      '必须用 atof 取带小数的帧率'
    );
    assert.ok(
      /\(int\)\(fv \+ 0\.5\)/.test(csrc),
      '必须四舍五入到整数（29.97→30、59.94→60）'
    );
  });

  test('native: 暂停必须同时冻结上屏进程 gst_pid', () => {
    // 真机 bug（用户反馈）：点暂停后**音频停了、画面还在放**。
    // 根因：视频是独立进程 `gst-launch-1.0 ... kmssink`，js_pause 只给 ff_pid 和
    // aplay_pid 发 SIGSTOP，kmssink 手里还压着 FIFO 里的帧，sync=true 会按 PTS
    // 继续 page-flip 直到吐完缓冲。
    /* ⚠️ 必须匹配带参数表的完整签名：indexOf('static JSValue js_pause') 会先命中
     * js_pauseRender（第 3616 行），拿到的函数体里当然没有 gst_pid。 */
    const pauseAt = csrc.indexOf('static JSValue js_pause(JSContext');
    const resumeAt = csrc.indexOf('static JSValue js_resume(JSContext');
    assert.ok(pauseAt > 0 && resumeAt > 0, 'js_pause / js_resume 都必须存在');
    const pauseBody = csrc.slice(pauseAt, resumeAt);
    assert.ok(
      /kill\(g_rd\.gst_pid, SIGSTOP\)/.test(pauseBody),
      'js_pause 必须给 g_rd.gst_pid 发 SIGSTOP'
    );
    const resumeBody = csrc.slice(resumeAt, csrc.indexOf('static JSValue', resumeAt + 10));
    assert.ok(
      /kill\(g_rd\.gst_pid, SIGCONT\)/.test(resumeBody),
      'js_resume 必须给 g_rd.gst_pid 发 SIGCONT（与 pause 配对）'
    );
  });

  test('native: 起播定格门存在、只对拆流生效、且有排查开关', () => {
    // 修「音画载入不同时」：首帧上屏后若音频还没开写（writer_bytes==0），
    // 画面必须定格等音频，而不是按名义帧率继续往前跑。
    // 关键约束：只对 DASH 拆流（audio_input[0]）生效 —— durl 单文件里音视频同进程，
    // 冻结视频读会反压 ffmpeg，音频就永远等不到，那才是真死锁。
    assert.ok(/PENDOUYU_HOLD_MAX_MS/.test(csrc), '必须有定格门超时上限');
    assert.ok(
      /s->writer_bytes <= 0[\s\S]{0,200}continue;/.test(csrc),
      '定格门必须在 writer_bytes<=0 时 continue（不读新帧）'
    );
    assert.ok(
      /s->audio_input\[0\][\s\S]{0,200}writer_bytes <= 0/.test(csrc),
      '定格门必须限定 audio_input[0]（DASH 拆流），否则 durl 会死锁'
    );
    assert.ok(
      /access\("\/tmp\/vp_nohold\.on", F_OK\) != 0/.test(csrc),
      '定格门要有 /tmp/vp_nohold.on 排查开关，且默认开启'
    );
  });

  test('native: 帧率上限 videorate 仍在归一化之前（先降帧再复制）', () => {
    // 顺序错了会先复制到 60 再丢到 30，白跑一倍像素。
    const capAt = csrc.indexOf('max-rate=%d');
    const normAt = csrc.indexOf('vp_nonorm.on');
    assert.ok(capAt > 0 && normAt > 0, '两处都必须存在');
    assert.ok(capAt < normAt, 'max-rate 的 videorate 必须排在归一化之前');
  });

  test('native: 迟到帧必须可丢（max-lateness 有限值 + qos=true 成组）', () => {
    // 真机 bug（用户反馈）：暂停几秒再恢复，画面「轻微卡顿」。
    // 取证（fpsdisplaysink 逐秒 current）：稳态 59.8，恢复后第 1 秒 7.0（一帧不出），
    // 第 2 秒 418.3（一秒涌出 400+ 帧），第 3 秒才回稳态。
    // 根因：SIGSTOP 期间 GstSystemClock 仍在走，恢复后暂停期间该播的 ~360 个 buffer
    // PTS 全部过期；旧配置 max-lateness=-1（永不判迟到）+ qos=false（不向上游报）
    // 让 kmssink 把过期帧全部照单翻页。
    // 修法：max-lateness=40（一帧 33ms 的 1.2 倍）+ qos=true。
    // 实测：旧配置峰值 417.84fps；新配置峰值 61.27fps 且**稳态 dropped 0**。
    assert.ok(
      /#define PENDOUYU_MAX_LATENESS_MS 40/.test(csrc),
      '必须有 PENDOUYU_MAX_LATENESS_MS 40'
    );
    /* ⚠️ 宏必须定义在 render_start 之前：曾放在第 2196 行（render_start 在第 800 行用它），
     * 编译直接报 `use of undeclared identifier`。 */
    const defineAt = csrc.indexOf('#define PENDOUYU_MAX_LATENESS_MS');
    const useAt = csrc.indexOf('PENDOUYU_MAX_LATENESS_MS)');
    assert.ok(defineAt > 0 && useAt > 0, '宏定义与使用都必须存在');
    assert.ok(defineAt < useAt, 'PENDOUYU_MAX_LATENESS_MS 必须定义在使用点之前');
    assert.ok(
      /no_late \? "false" : "true"/.test(csrc),
      'qos 必须默认 true（只有 /tmp/vp_nolate.on 才回退 false）'
    );
    assert.ok(
      /access\("\/tmp\/vp_nolate\.on", F_OK\) == 0/.test(csrc),
      '要有 /tmp/vp_nolate.on 排查开关回退旧行为'
    );
  });

  test('native: seek 落点补偿（关键帧回退导致的音画错位）', () => {
    // 真机 bug（用户反馈）：拖进度条从新位置起播后音画不同步。
    // 根因：`-c:v copy` 的 `-ss` 只能落在关键帧（本机间隔 5s），音频是解码输出能精确落点。
    // 实测 `-ss 155.366`：视频首包 -0.365s、音频首包 -0.001s ⇒ 画面永久领先 365ms。
    // 修法：把 |land| 换算成帧数，直接丢弃视频前 N 帧，使首帧上屏时内容位置 == start_ms。
    assert.ok(
      /seek_skip_frames/.test(csrc),
      '必须有 seek_skip_frames 字段（要丢弃的帧数）'
    );
    assert.ok(
      /s->seek_skip_frames = \(long\)\(\(double\)\(-land\) \* \(double\)s->fps \/ 1000\.0 \+ 0\.5\)/.test(csrc),
      '必须把落点毫秒换算成帧数（四舍五入）'
    );
    assert.ok(
      /s->video_base_ms = s->start_ms \+ land/.test(csrc),
      '内容时钟基线必须同步前移，否则 position 会从关键帧算起'
    );
    assert.ok(
      /access\("\/tmp\/vp_noseekskip\.on", F_OK\) == 0/.test(csrc),
      '要有 /tmp/vp_noseekskip.on 排查开关'
    );
    /* 丢弃分支必须真的消费掉 AU 并 continue（不写 FIFO），否则等于没丢。 */
    const skipAt = csrc.indexOf('if (s->seek_skip_frames > 0) {');
    assert.ok(skipAt > 0, '必须有丢弃分支');
    const skipBody = csrc.slice(skipAt, skipAt + 1600);
    assert.ok(/au_consume\(s, au_n\)/.test(skipBody), '丢弃分支必须消费掉该 AU');
    assert.ok(/continue;/.test(skipBody), '丢弃分支必须 continue（不走上屏路径）');
    /* spawn 时必须清零，否则断流重连会白丢上一轮的帧。 */
    assert.ok(
      /s->seek_land_valid = 0;[\s\S]{0,200}s->seek_skip_frames = 0;/.test(csrc),
      'spawn_ffmpeg 必须清零落点补偿状态'
    );
  });
}

main().then(
  async () => {
    // 等全部异步用例落定（含看门狗），再汇总退出
    try {
      await Promise.all(pending);
    } catch (e) {
      /* 单测失败已计入 failed */
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed > 0 ? 1 : 0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);