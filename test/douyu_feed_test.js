// 斗鱼服务层联网冒烟测试（宿主机 Node 跑，不是笔端）
//
//   cd PenDouyu && node test/douyu_feed_test.js
//
// 设计要点：
//   * **跑的是产品代码本身**，不是复制一份逻辑过来对拍 —— 探针阶段已经发现过
//     「cid1 写死 2」「cid2=0 必须走 0_0」「rate 会被降档」这类坑，只有真跑才认得出。
//   * 笔端网络栈是 $falcon.jsapi.http.request（成功 {result:<body>}、非 2xx 时
//     {error:3,result:{errorMessage:'curl ... resCode:N'}}、**没有 statusCode 字段**）。
//     这里用 node 24 的全局 fetch 实现一个同构 shim 注入到 globalThis.$falcon，
//     于是 net.js/坐标/签名/解包/错误归一全都走真实路径，只是最底层换成了 fetch。
//   * storage 用不到（没有 $falcon.jsapi.storage）→ ensureDid() 会走「生成 + 内存」分支，
//     正好顺带验证「storage 不可用时仍能取流」。
//
// 只读，不写任何远端状态。列表/分类/搜索走 GET，**取流 getH5PlayV1 必须走 POST**
// （GET 只有 17.5% 成功率，其余被服务端糊成 -15「非法请求」，见 douyu/api.js 文件头 A）。
const assert = require('assert');

// ---- $falcon 同构 shim：把 jsapi.http.request 映射到 fetch ----
function installFalconShim() {
  let calls = 0;
  globalThis.$falcon = {
    jsapi: {
      http: {
        request(options, cb) {
          calls++;
          const headers = options && options.header ? options.header : {};
          const p = fetch(options.url, { method: options.method || 'GET', headers: headers }).then(
            async (r) => {
              const text = await r.text();
              if (r.status >= 200 && r.status < 300) {
                // 笔端成功形态：{result: <body 字符串>}，无 statusCode
                return { result: text };
              }
              // 笔端失败形态：body 不可得，只有 resCode 文本
              return { error: 3, result: { errorMessage: 'curl: (22) resCode:' + r.status } };
            },
            (e) => ({ error: 3, result: { errorMessage: 'curl: (6) ' + (e && e.message) } })
          );
          // 真机既有回调式也有 Promise 式；net.js 两种都接，这里返回 Promise 走 then 分支
          return p.then((res) => {
            if (typeof cb === 'function') cb(res, null);
            return res;
          });
        }
      }
      // 故意不提供 storage：验证 storage 不可用时 did 生成/取流仍可用
    }
  };
  return () => calls;
}

function line(t) {
  console.log(t);
}
function hr(t) {
  console.log('\n=== ' + t + ' ===');
}

async function main() {
  installFalconShim();

  const api = await import('../src/services/douyu/api.js');
  const feed = await import('../src/services/douyu/feed.js');
  const cate = await import('../src/services/douyu/cate.js');
  const norm = await import('../src/services/douyu/normalize.js');

  let failures = 0;
  const check = (name, cond, extra) => {
    if (cond) console.log('  ok   ' + name);
    else {
      failures++;
      console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''));
    }
  };

  // ---------- 0. 纯函数（不联网）----------
  hr('0. 纯函数自检');
  const { md5Hex } = await import('../src/services/md5.js');
  // 签名公式对拍 doc §1：f = rand_str；循环 enc_time 次 f = md5(f + key)；
  //                        auth = md5(f + key + String(rid) + String(ts))
  const f1 = api.deriveSigningKey('RANDSTR', 'KEY', 3);
  let manual = 'RANDSTR';
  for (let i = 0; i < 3; i++) manual = md5Hex(manual + 'KEY');
  check('deriveSigningKey 与手写 md5 链一致', f1 === manual, f1 + ' vs ' + manual);
  check('buildAuth 与手写公式一致', api.buildAuth(f1, 'KEY', 36252, 1700000000) === md5Hex(f1 + 'KEY' + '36252' + '1700000000'));
  check('enc_time=1 时只循环一次', api.deriveSigningKey('A', 'K', 1) === md5Hex('A' + 'K'));

  check('推荐 URL 用 0_0', feed.buildMixListUrl(0, 1) === 'https://www.douyu.com/gapi/rkc/directory/mixList/0_0/1', feed.buildMixListUrl(0, 1));
  check('分区 URL 用 2_{cid2}', feed.buildMixListUrl(181, 2) === 'https://www.douyu.com/gapi/rkc/directory/mixList/2_181/2', feed.buildMixListUrl(181, 2));
  check('cid2 非法值退化为推荐', feed.buildMixListUrl(null, 1).indexOf('/0_0/') > 0);
  check('页码 0/负 归一为 1', feed.buildMixListUrl(1, 0).slice(-2) === '/1');

  const playUrl = api.buildPlayUrl(
    36252,
    2,
    { did: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', enc_data: 'X'.repeat(696), key: 'K', f: 'F' },
    1700000000
  );
  check('取流 URL 含 ver=Douyu_224011102', playUrl.indexOf('ver=Douyu_224011102') > 0);
  check('取流 URL 含 iar=0', playUrl.indexOf('iar=0') > 0);
  check('取流 URL 含 rate=', playUrl.indexOf('rate=2') > 0);
  line('  取流 URL 长度（enc_data 696 字符时）：' + playUrl.length + ' 字符 —— 远低于 2000（POST 的 query 同样走 URL）');

  // normalize 的图片档位
  const rawRoom = {
    rid: 123,
    rn: '测试  标题',
    nn: '主播',
    rs16: 'https://rpic.douyucdn.cn/a/b/c.jpg/dy1',
    rs1: 'https://rpic.douyucdn.cn/a/b/c.jpg/dy2',
    av: 'avatar_v3/202102/abc',
    ol: 123456,
    c2name: '英雄联盟',
    cid2: 1
  };
  const it16 = norm.normalizeRoom(rawRoom);
  check('默认封面用 rs16 且降 http', it16.cover === 'http://rpic.douyucdn.cn/a/b/c.jpg/dy1', it16.cover);
  check('size=rs1 时用大图', norm.normalizeRoom(rawRoom, { size: 'rs1' }).cover.indexOf('/dy2') > 0);
  check('头像拼 _middle.jpg', it16.avatar === 'http://apic.douyucdn.cn/upload/avatar_v3/202102/abc_middle.jpg', it16.avatar);
  check('头像 size=big', norm.normalizeAvatar('avatar_v3/202102/abc', 'big').indexOf('_big.jpg') > 0);
  check('已是完整 URL 的头像不重复拼', norm.normalizeAvatar('https://apic.douyucdn.cn/upload/x/yy_small.jpg').indexOf('_middle.jpg') > 0);
  check('人气格式化 万', it16.onlineText === '12.3万', it16.onlineText);
  check('title 压空白', it16.title === '测试 标题', it16.title);
  check('ol=0 标 offline', norm.normalizeRoom({ rid: 1, ol: 0 }).offline === true);
  check('非法条目被丢弃', norm.normalizeRoom({ rid: 'abc' }) === null);
  check('rates 归一', JSON.stringify(api.normalizeRates([{ name: '高清', rate: 2, bit: 900, diamondFan: 1 }])) === '[{"name":"高清","rate":2,"bit":900}]');

  // ---------- 1. did ----------
  hr('1. did');
  const did = await api.ensureDid();
  check('ensureDid 返回 32 位小写 hex', /^[0-9a-f]{32}$/.test(did), did);
  check('ensureDid 幂等', (await api.ensureDid()) === did);
  check('getCachedDid 同步可用', api.getCachedDid() === did, api.getCachedDid());
  line('  did = ' + did);

  // ---------- 2. 分类树 ----------
  hr('2. 分类树 getLeftNav');
  const cats = await feed.fetchCategories();
  const subCount = cats.reduce((n, c) => n + c.subs.length, 0);
  line('  一级分类 ' + cats.length + ' 个，二级分类共 ' + subCount + ' 个');
  for (const c of cats) line('    ' + c.id + ' ' + c.name + ' (' + c.subs.length + ')');
  check('一级分类数 = 5', cats.length === 5, String(cats.length));
  check('二级分类数 = 55', subCount === 55, String(subCount));
  check('每个一级都有 subs', cats.every((c) => c.subs.length > 0));
  check('subs 元素形如 {cid1,cid2,name}', cats.every((c) => c.subs.every((s) => typeof s.cid2 === 'number' && typeof s.name === 'string')));
  check('分类树里保留了原始 cid1（非 2，仅展示用）', cats.some((c) => c.subs.some((s) => s.cid1 !== 2)));

  // ---------- 3. 推荐列表 ----------
  hr('3. 推荐房间 mixList/0_0/1');
  const rcmd = await feed.fetchLiveList(0, 1, { hideOffline: false });
  check('推荐列表 ok', rcmd.ok === true, JSON.stringify(rcmd.errorText || ''));
  line('  原始房间 ' + rcmd.items.length + ' 条（含未开播 ' + rcmd.items.filter((x) => x.offline).length + '），pgcnt=' + rcmd.total);
  for (const it of rcmd.items.slice(0, 3)) {
    line('    {rid:' + it.rid + ', title:"' + it.title + '", streamer:"' + it.streamer + '", cover:"' + it.cover + '"}');
  }
  check('推荐返回 120 条', rcmd.items.length === 120, String(rcmd.items.length));
  check('pgcnt > 0（总页数）', rcmd.total > 1, String(rcmd.total));
  check('item 形状符合契约', rcmd.items.every((x) => x.site === 'douyu' && typeof x.rid === 'number' && typeof x.title === 'string' && typeof x.cover === 'string' && x.isLive === true));
  const rcmdVisible = await feed.fetchLiveList(0, 1);
  check('默认剔除未开播（hideOffline=true）', rcmdVisible.items.length <= rcmd.items.length && rcmdVisible.items.every((x) => !x.offline));
  line('  默认可见（剔除 ol=0 后）' + rcmdVisible.items.length + ' 条');

  // 翻页
  const p2 = await feed.fetchLiveList(0, 2);
  check('第 2 页与第 1 页不重复', p2.ok && p2.items.length > 0 && p2.items[0].rid !== rcmd.items[0].rid, String(p2.items[0] && p2.items[0].rid));
  const p999 = await feed.fetchLiveList(0, 999);
  check('越界页返回空列表且不报错', p999.ok === true && p999.items.length === 0);

  // ---------- 4. 分区列表 ----------
  hr('4. 分区房间');
  const wanted = ['英雄联盟', '原神'];
  const found = [];
  for (const cn of wanted) {
    for (const c of cats) for (const s of c.subs) if (s.name.indexOf(cn) >= 0) found.push(s);
  }
  check('分类树里能查到 英雄联盟/原神', found.length >= 2, found.map((s) => s.name + ':' + s.cid2).join(','));
  for (const s of found.slice(0, 2)) {
    const r = await feed.fetchLiveList(s.cid2, 1, { hideOffline: false });
    line('  ' + s.name + ' (cid2=' + s.cid2 + ') 房间 ' + r.items.length + ' 条，pgcnt=' + r.total + '，其中未开播 ' + r.items.filter((x) => x.offline).length);
    check('分区 ' + s.name + ' 有房间', r.ok === true && r.items.length > 0);
  }

  // ---------- 5. 搜索兜底 ----------
  hr('5. 搜索兜底 getSearchRec（关键词：王者）');
  // getSearchRec 偶发传输层拒绝（见 cate.js 注释）；产品代码已重试一次，测试这里再兜一层，
  // 避免把「一次网络抖动」报成功能失败。
  let cand = await cate.fetchCateByKeyword('王者');
  if (!cand.length) cand = await cate.fetchCateByKeyword('王者');
  line('  候选分类 ' + cand.length + ' 个: ' + cand.map((c) => c.name + '(' + c.cid2 + '/' + c.showNum + ')').join(', '));
  const sr = await feed.searchLive('王者');
  line('  结果 ' + sr.items.length + ' 条，来源 via=' + sr.via);
  for (const it of sr.items.slice(0, 3)) line('    {rid:' + it.rid + ', title:"' + it.title + '", streamer:"' + it.streamer + '"}');
  check('搜索有候选分类', cand.length > 0);
  check('搜索结果 ok 且非空', sr.ok === true && sr.items.length > 0);
  check('via 取值合法', sr.via === 'direct' || sr.via === 'cate');
  check('direct 时每条都命中关键词', sr.via !== 'direct' || sr.items.every((x) => feed.matchKeyword(x, '王者')));
  check('空关键词返回空且不联网报错', (await feed.searchLive('   ')).items.length === 0);

  // via:'cate' 分支：关键词是**分类名**，但没人把它写进标题 → 服务端 cateResult
  // 命中分类、本地过滤却命中 0 条 → 退回该分类全部房间并标 via:'cate'。
  //
  // 注意：这一支**不能硬断言 via==='cate'**。实测同一个词「三角洲行动」有时命中
  // 1 条标题（主播在打这游戏就写进标题）→ via:'direct'，有时 0 条 → via:'cate'，
  // 两种都是**正确**行为，取决于当时哪个房间在播。硬断言会让集成测试随机红。
  // 所以这里只断言契约（ok/非空/via 合法/item 形状），并在真的走到 cate 时额外校验。
  const cateOnly = await feed.searchLive('三角洲行动');
  line('  「三角洲行动」→ ' + cateOnly.items.length + ' 条，via=' + cateOnly.via);
  check('分类名关键词有结果（direct 或 cate 都算对）',
    cateOnly.ok === true && cateOnly.items.length > 0 && (cateOnly.via === 'direct' || cateOnly.via === 'cate'),
    cateOnly.via + '/' + cateOnly.items.length);
  if (cateOnly.via === 'cate') {
    check('via:cate 时回退到该分类全部房间（不止 1 条）', cateOnly.items.length > 1, String(cateOnly.items.length));
  } else {
    check('via:direct 时每条都命中关键词', cateOnly.items.every((x) => feed.matchKeyword(x, '三角洲行动')));
  }
  check('via:cate 时 item 仍是统一形状', cateOnly.items.every((x) => x.site === 'douyu' && typeof x.rid === 'number'));

  // ---------- 6. 取流 ----------
  hr('6. 取流 getH5PlayV1');
  // 用推荐流里第一个**在播**的房间（不写死 rid，测试用 URL 不进产品代码）
  const target = rcmdVisible.items[0];
  check('拿到一个在播房间用于取流', !!target, '推荐流为空');
  if (target) {
    line('  目标房间 rid=' + target.rid + ' "' + target.title + '"');
    const info = await api.fetchPlayInfo(target.rid, 2);
    line('  ok=' + info.ok + ' rate=' + info.rate);
    line('  URL 前 80 字符: ' + String(info.url || '').slice(0, 80));
    line('  multirates: ' + JSON.stringify(info.rates));
    check('取流 ok', info.ok === true, info.errorText || String(info.error));
    check('url 是 http(s) FLV 直链', /^https?:\/\//.test(String(info.url)) && /\.flv/.test(String(info.url)), String(info.url).slice(0, 60));
    check('url 带签名参数', String(info.url).indexOf('wsAuth=') > 0 || String(info.url).indexOf('token=') > 0);
    check('rates 元素形如 {name,rate,bit}', Array.isArray(info.rates) && info.rates.length > 0 && info.rates.every((r) => typeof r.name === 'string' && typeof r.rate === 'number' && typeof r.bit === 'number'));
    check('返回的是服务端实际 rate', typeof info.rate === 'number' && info.rate >= 0);

    // 换一档：必须重新签名（doc §1）
    const alt = info.rates.filter((r) => r.rate !== info.rate)[0];
    if (alt) {
      const info2 = await api.fetchPlayInfo(target.rid, alt.rate);
      line('  换档 rate=' + alt.rate + '(' + alt.name + ') → ok=' + info2.ok + ' 实际 rate=' + info2.rate);
      check('换档可单独签名成功', info2.ok === true, info2.errorText || '');
      check('两档直链不同（各自签名）', !info2.ok || info2.url !== info.url);
    }
    // 房间不存在 → -3（改 POST 后服务端的错误码变精细了：
    //   -3 不存在 / -4 封禁 / -5 未开播 / -15 是 GET 时代的万能码）
    const bogus = await api.fetchPlayInfo(999999999, 2);
    line('  不存在的房间 → ok=' + bogus.ok + ' error=' + bogus.error + ' text=' + bogus.errorText);
    check('不存在房间返回 ok:false 且不 throw', bogus.ok === false);
    check('不存在房间错误码为 -3', Number(bogus.error) === -3, String(bogus.error));
    check('非法 rid 被本地拦下', (await api.fetchPlayInfo(0, 2)).ok === false);
  }

  // ---------- 7. 错误语义 ----------
  hr('7. 错误语义');
  check('describeDouyuError -3 房间不存在', api.describeDouyuError(-3, '房间不存在').indexOf('不存在') > 0);
  check('describeDouyuError -5 未开播', api.describeDouyuError(-5, '').indexOf('未开播') > 0);
  check('describeDouyuError -4 封禁', api.describeDouyuError(-4, '').indexOf('封禁') > 0);
  // -15 是 GET 时代的万能码，POST 后基本见不到，但保留识别做兜底
  check('describeDouyuError -15 兜底', api.describeDouyuError(-15, '非法请求').indexOf('不存在') > 0);
  check('describeDouyuError -9 提示校时', api.describeDouyuError(-9, '时间戳错误').indexOf('时钟') > 0);
  check('describeDouyuError 1000 提示 did', api.describeDouyuError(1000, '').indexOf('did') >= 0);

  // ---------- 8. 断网/异常不 throw ----------
  hr('8. 异常路径不 throw');
  const saved = globalThis.$falcon;
  globalThis.$falcon = { jsapi: {} }; // 无 http
  const noNet = await feed.fetchLiveList(0, 1);
  const noNet2 = await api.fetchPlayInfo(36252, 2);
  const noNet3 = await feed.searchLive('王者');
  check('无网络时 fetchLiveList 返回 ok:false', noNet.ok === false && Array.isArray(noNet.items));
  check('无网络时 fetchPlayInfo 返回 ok:false', noNet2.ok === false);
  check('无网络时 searchLive 不 throw', noNet3.ok === false && Array.isArray(noNet3.items));
  globalThis.$falcon = saved;

  hr('结果');
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败');
  assert(failures === 0, failures + ' 项失败');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n测试异常终止: ' + ((e && e.stack) || e));
    process.exit(1);
  }
);
