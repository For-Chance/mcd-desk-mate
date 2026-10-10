'use strict';

/**
 * 麦娘的「脑子」。
 *
 * 负责调用麦当劳 MCP 工具 → 用 parse.js 把 Markdown 响应还原成结构 → 组织成快照，
 * 最后翻译成人设化的中文播报。
 *
 * 实测前提：MCP 返回的是 Markdown 文本而非 JSON，因此所有数据都必须先过解析器。
 * 设计原则：任一工具失败都不影响整体，降级为 null 并继续。
 */

const {
  parseAccount,
  parseClaimable,
  parseWallet,
  parseCampaigns,
  parseOrders,
  parseNutrition,
  parseStores,
  parseClaimResult,
  parseLottery,
  parseDrawResult,
  parsePrizes,
  parseServerTime
} = require('./parse.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// 抽奖最短间隔。官方文档明确：短时间内重复调用会返回「操作太频繁」，
// 这里我们主动挡一道，既保护用户积分，也避免触发服务端限流。
const DRAW_COOLDOWN_MS = 8000;

/**
 * 二十四节气。
 * 实测发现麦当劳「周六麦金喜抽奖」的奖品里有一类「门票」，名称直接采用节气名，
 * 于是奖品墙天然构成一套可收集的图鉴 —— 这是纯业务数据里长出来的玩法，不需要额外配置。
 */
const SOLAR_TERMS = [
  '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降',
  '立冬', '小雪', '大雪', '冬至', '小寒', '大寒'
];

// 节气近似公历日期（月, 日）。用于「下一个节气还有几天」的提醒，
// 精确到天即可，误差 ±1 天不影响体验。
const SOLAR_DATES = [
  [1, 5, '小寒'], [1, 20, '大寒'], [2, 4, '立春'], [2, 19, '雨水'],
  [3, 5, '惊蛰'], [3, 20, '春分'], [4, 4, '清明'], [4, 20, '谷雨'],
  [5, 5, '立夏'], [5, 21, '小满'], [6, 5, '芒种'], [6, 21, '夏至'],
  [7, 7, '小暑'], [7, 22, '大暑'], [8, 7, '立秋'], [8, 23, '处暑'],
  [9, 7, '白露'], [9, 23, '秋分'], [10, 8, '寒露'], [10, 23, '霜降'],
  [11, 7, '立冬'], [11, 22, '小雪'], [12, 7, '大雪'], [12, 22, '冬至']
];

/** 距离今天最近的那个节气。 */
function nextSolarTerm(now) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const [m, d, name] of SOLAR_DATES) {
    const days = Math.round((new Date(now.getFullYear(), m - 1, d).getTime() - base) / DAY_MS);
    if (days >= 0) return { name, month: m, day: d, days };
  }
  const days = Math.round((new Date(now.getFullYear() + 1, 0, 5).getTime() - base) / DAY_MS);
  return { name: '小寒', month: 1, day: 5, days };
}

function textOf(raw) {
  return Array.isArray(raw) ? raw.join('\n') : raw;
}

/** 把服务器日期串转成 Date；解析不出来就退回本地时间，不让它变成硬错误。 */
function toDate(serverTime) {
  if (serverTime && serverTime.formatted) {
    const t = Date.parse(serverTime.formatted.replace(/-/g, '/'));
    if (!Number.isNaN(t)) return new Date(t);
  }
  return new Date();
}

function daysSince(dateText) {
  if (!dateText) return null;
  const t = Date.parse(String(dateText).replace(/-/g, '/'));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

class PetBrain {
  constructor(client, { onEvent } = {}) {
    this.client = client;
    this.onEvent = onEvent || (() => {});
    this.snapshot = null;
  }

  async _safe(tool, args = {}) {
    try {
      return await this.client.callTool(tool, args);
    } catch (err) {
      this.onEvent({ type: 'tool-error', tool, message: err.message });
      return null;
    }
  }

  /** 拉取一次核心数据快照。 */
  async refresh() {
    if (!this.client.configured) return null;

    const [walletRaw, claimableRaw, accountRaw, campaignRaw, orderRaw, timeRaw] = await Promise.all([
      this._safe('query-my-coupons'),
      this._safe('available-coupons'),
      this._safe('query-my-account'),
      this._safe('campaign-calendar'),
      this._safe('order-list'),
      this._safe('now-time-info')
    ]);

    const wallet = parseWallet(walletRaw);
    const claimable = parseClaimable(claimableRaw);
    const points = parseAccount(accountRaw);
    const campaigns = parseCampaigns(campaignRaw);
    const orders = parseOrders(orderRaw);
    const serverTime = parseServerTime(timeRaw);

    const todayBlocks = campaigns.blocks.filter((b) => b.label === '今日');
    const futureBlocks = campaigns.blocks.filter((b) => b.label === '');

    const expiringToday = wallet.list.filter((c) => c.expiringToday);
    const latest = orders[0] || null;

    const productCount = new Map();
    for (const o of orders) {
      for (const p of o.products) productCount.set(p, (productCount.get(p) || 0) + 1);
    }
    const topProducts = [...productCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, count: n }));

    this.snapshot = {
      wallet: {
        total: wallet.total,
        list: wallet.list,
        expiringToday: expiringToday.map((c) => c.name)
      },
      claimable: {
        total: claimable.length,
        list: claimable.slice(0, 8)
      },
      points,
      campaigns: {
        serverTime: campaigns.serverTime,
        todayCount: todayBlocks.reduce((n, b) => n + b.count, 0),
        todayTitles: todayBlocks.flatMap((b) => b.entries.map((e) => e.title)),
        upcomingCount: futureBlocks.reduce((n, b) => n + b.count, 0),
        upcomingTitles: futureBlocks.flatMap((b) => b.entries.map((e) => e.title)).slice(0, 5)
      },
      orders: {
        total: orders.length,
        latest,
        daysSinceLast: latest ? daysSince(latest.createTime) : null,
        topProducts
      },
      serverTime,
      nextTerm: nextSolarTerm(toDate(serverTime)),
      updatedAt: Date.now()
    };

    return this.snapshot;
  }

  /**
   * 播报应当是什么情绪。
   * 券今天到期的时候她还笑嘻嘻的就说不过去了 —— 这里给渲染层一个真实的情绪信号，
   * 让它决定要不要冒感叹号、要不要把气泡转成警示色。
   */
  briefingMood() {
    const s = this.snapshot;
    if (!s) return 'think';
    if (s.wallet.expiringToday.length > 0) return 'urgent';
    if (s.points.expiringThisMonth > 0) return 'urgent';
    if (s.claimable.total > 0) return 'happy';
    if (s.campaigns.todayCount > 0) return 'happy';
    return 'normal';
  }

  /** 启动 / 定时播报：按紧急程度挑最值得说的一两件事。 */
  buildBriefing() {
    const s = this.snapshot;
    if (!s) return '我还没连上麦当劳服务呢，先帮我配置一下 Token 吧～';

    // 第一优先级：今天过期的券，不提醒就亏了
    if (s.wallet.expiringToday.length > 0) {
      const n = s.wallet.expiringToday.length;
      const name = s.wallet.expiringToday[0];
      return `${n > 1 ? `你有 ${n} 张券今天到期` : `「${name}」今天就要到期了`}${n > 1 ? `，比如${name}` : ''}，趁着还没过期去用掉呀！`;
    }

    if (s.claimable.total > 0) {
      return `麦麦省有 ${s.claimable.total} 张券可以领，要我帮你一键全领了吗？`;
    }
    if (s.points.expiringThisMonth > 0) {
      return `有 ${s.points.expiringThisMonth} ${s.points.currency}这个月就要过期了，去麦麦商城换点东西吧～`;
    }
    if (s.campaigns.todayCount > 0) {
      const t = s.campaigns.todayTitles[0];
      return `今天有活动上线：${t}，记得看一眼～`;
    }
    if (s.campaigns.upcomingCount > 0) {
      const t = s.campaigns.upcomingTitles[0];
      return `接下来有 ${s.campaigns.upcomingCount} 个活动要开始啦，最近的是「${t}」。`;
    }
    if (s.wallet.total > 0) {
      return `你手上有 ${s.wallet.total} 张券，别放过期啦。`;
    }
    if (s.orders.daysSinceLast !== null && s.orders.daysSinceLast >= 14) {
      return `已经 ${s.orders.daysSinceLast} 天没吃过麦当劳了，有点想你哦～`;
    }
    // 没有急事时聊一句当下正在发生的事，而不是每次念叨同一句兜底文案
    return this.flavorLine() || '今天暂时没有新券和新活动，安心吃就好～';
  }

  /**
   * 一句贴合此刻的话。
   * 时间取自 MCP 的 now-time-info 而不是本地时钟 —— 用户机器时间不准的话，
   * 她「现在是早餐时段」就会说得莫名其妙。
   */
  flavorLine() {
    const s = this.snapshot;
    const now = toDate(s && s.serverTime);
    const h = now.getHours();

    // 节气临近优先 —— 与收藏册的节气门票是同一套彩蛋
    const term = s && s.nextTerm;
    if (term && term.days <= 7) {
      return `「${term.name}」还有 ${term.days} 天就到了，到时候去抽奖碰碰运气，说不定能集到一张新门票～`;
    }
    if (h >= 23 || h < 5) return '都这个点了…如果要点夜宵，我假装没看见。';
    if (h < 10) return '现在是早餐时段，早餐券这时候用最划算。';
    if (h >= 14 && h < 17) return '下午茶时间到～要不要看看有什么券能用？';
    if (h >= 17 && h < 21) return '晚饭时间啦，今天想吃什么？';
    return '';
  }

  /** 当前时段。 */
  mealtime() {
    const now = toDate(this.snapshot && this.snapshot.serverTime);
    const h = now.getHours();
    if (h >= 5 && h < 10) return { key: 'breakfast', label: '早餐' };
    if (h >= 10 && h < 14) return { key: 'lunch', label: '午餐' };
    if (h >= 14 && h < 17) return { key: 'teatime', label: '下午茶' };
    if (h >= 17 && h < 21) return { key: 'dinner', label: '晚餐' };
    return { key: 'latenight', label: '夜宵' };
  }

  /** 一键领取麦麦省全部可用券。 */
  async claimAllCoupons() {
    const res = await this._safe('auto-bind-coupons');
    if (res === null) return { ok: false, message: '领券失败，可能是网络问题，稍后再试试～' };

    const r = parseClaimResult(Array.isArray(res) ? res.join('\n') : res);
    if (r.success > 0) {
      const first = r.names[0] ? `，比如「${r.names[0]}」` : '';
      return { ok: true, message: `好耶，一口气领了 ${r.success} 张券${first}！`, refresh: true };
    }
    if (r.total === 0) {
      return { ok: true, message: '能领的券都已经在你账户里啦，没有新的。' };
    }
    return { ok: false, message: `领券没成功，全部失败了（共 ${r.total} 张）。` };
  }

  /** 券盘点播报。 */
  async couponReport() {
    if (!this.snapshot) await this.refresh();
    const s = this.snapshot;
    if (!s) return { ok: false, message: '还没连上麦当劳服务哦。' };

    if (s.wallet.total === 0 && s.claimable.total === 0) {
      return { ok: true, message: '你目前没有优惠券，麦麦省这会儿也没有可领的新券。' };
    }
    if (s.wallet.expiringToday.length > 0) {
      return { ok: true, message: `注意啦，「${s.wallet.expiringToday[0]}」今天就到期！` };
    }
    let msg = `你手上有 ${s.wallet.total} 张券`;
    if (s.claimable.total > 0) msg += `，麦麦省还有 ${s.claimable.total} 张可以领`;
    msg += '。';
    return { ok: true, message: msg, detail: s.wallet.list.map((c) => c.name) };
  }

  /** 积分播报。 */
  async pointsReport() {
    const account = await this._safe('query-my-account');
    if (!account) return { ok: false, message: '积分查询失败，稍后再试～' };

    const p = parseAccount(account);
    let message = `你现在有 ${p.available} ${p.currency}，累计攒过 ${p.accumulative}。`;
    if (p.expiringThisMonth > 0) message += `这个月有 ${p.expiringThisMonth} 分要过期，快去换掉！`;
    else if (p.expiringNextMonth > 0) message += `下个月会有 ${p.expiringNextMonth} 分过期哦。`;
    return { ok: true, message };
  }

  /** 活动播报。 */
  async campaignReport() {
    const raw = await this._safe('campaign-calendar');
    if (!raw) return { ok: false, message: '活动日历没查到，稍后再试～' };

    const c = parseCampaigns(raw);
    if (c.items.length === 0) return { ok: true, message: '这个月暂时没有正在进行的活动。' };

    const todayTitles = c.blocks.filter((b) => b.label === '今日').flatMap((b) => b.entries.map((e) => e.title));
    const upcoming = c.blocks.filter((b) => b.label === '').flatMap((b) => b.entries.map((e) => e.title));

    if (todayTitles.length > 0) {
      return { ok: true, message: `今天上线的是「${todayTitles[0]}」${todayTitles.length > 1 ? `等 ${todayTitles.length} 个活动` : ''}。` };
    }
    if (upcoming.length > 0) {
      return { ok: true, message: `接下来有 ${upcoming.length} 个活动，最近的是「${upcoming[0]}」。` };
    }
    return { ok: true, message: `本月共有 ${c.items.length} 场活动安排。` };
  }

  /** 最近订单播报。 */
  async orderReport() {
    const raw = await this._safe('order-list');
    if (!raw) return { ok: false, message: '订单没查到，稍后再试～' };

    const list = parseOrders(raw);
    if (list.length === 0) return { ok: true, message: '还没有历史订单记录。' };

    const latest = list[0];
    const days = daysSince(latest.createTime);
    let message = `最近一单是${latest.createTime ? latest.createTime.slice(0, 10) : '近期'}在${latest.storeName || '麦当劳'}，花了 ${latest.amount} 元`;
    if (latest.products.length > 0) message += `，买了${latest.products.slice(0, 2).join('、')}`;
    message += '。';
    if (days !== null) message += `那是 ${days} 天前的事啦。`;

    return { ok: true, message, detail: { store: latest.storeName, days, products: latest.products } };
  }

  /**
   * 附近门店播报。
   * 实测：query-nearby-stores 在无收藏餐厅时必须同时给出 city 与 keyword，
   * 否则返回「城市名或者关键词不能为空」。beType=1 到店自提，searchType=2 关键词搜索。
   */
  async storeReport({ city = '', keyword = '' } = {}) {
    if (!city) {
      return { ok: false, message: '还没设置城市呢，在设置里填一下，我才能帮你找附近的餐厅～' };
    }

    const args = { beType: 1, searchType: keyword ? 2 : 1, city };
    if (keyword) args.keyword = keyword;

    const raw = await this._safe('query-nearby-stores', args);
    if (!raw) return { ok: false, message: '门店查询失败，稍后再试试～' };

    const s = parseStores(Array.isArray(raw) ? raw.join('\n') : raw);
    if (s.error) return { ok: true, message: `还没找到门店（${s.error}），在设置里填个城市或关键词会更准～` };
    if (s.list.length === 0) return { ok: true, message: '这个位置附近没找到门店。' };

    const first = s.list[0];
    const hours = first.businessHours ? `，营业时间 ${first.businessHours}` : '';
    return {
      ok: true,
      message: `最近的是「${first.storeName}」${hours}，${first.open ? '现在还在营业哦' : '现在打烊啦'}。`
    };
  }

  /** 营养速查：在 160 条真实营养数据里按关键词找餐品。 */
  async nutritionLookup(keyword) {
    const raw = await this._safe('list-nutrition-foods');
    if (!raw) return { ok: false, message: '营养数据没查到，稍后再试～' };

    const list = parseNutrition(Array.isArray(raw) ? raw.join('\n') : raw);
    if (list.length === 0) return { ok: true, message: '没有拿到营养数据。' };

    let item = null;
    if (keyword) {
      const kw = String(keyword).replace(/\s/g, '');
      item = list.find((it) => it.name.includes(kw)) || list.find((it) => kw.includes(it.name));
    }
    item = item || list[0];

    return {
      ok: true,
      message: `${item.name}：${item.energyKcal} 大卡，蛋白质 ${item.protein}g，脂肪 ${item.fat}g，碳水 ${item.carbohydrate}g，钠 ${item.sodium}mg。数据参考官方营养表哦～`
    };
  }

  /* ------------------------------------------------------------ 营养小工具 */

  async _nutritionList() {
    const raw = await this._safe('list-nutrition-foods');
    if (!raw) return [];
    return parseNutrition(textOf(raw)).filter((it) => it.name && it.energyKcal > 0);
  }

  /** 给「投喂」面板用的今日菜单：轻食 / 常规 / 硬菜各两款，全部来自真实营养表。 */
  async menuOptions() {
    const list = await this._nutritionList();
    if (list.length === 0) return { ok: false, message: '营养数据没查到，稍后再试～', list: [] };

    const sorted = [...list].sort((a, b) => a.energyKcal - b.energyKcal);
    const band = (from, to) => sorted.slice(Math.floor(sorted.length * from), Math.floor(sorted.length * to));
    const take = (pool, n, used) => {
      const out = [];
      for (let guard = 0; out.length < n && guard < 40; guard += 1) {
        const it = pool[Math.floor(Math.random() * pool.length)];
        if (it && !used.has(it.name)) { used.add(it.name); out.push(it); }
      }
      return out;
    };

    const used = new Set();
    const menu = [
      ...take(band(0, 0.35), 2, used),
      ...take(band(0.35, 0.7), 2, used),
      ...take(band(0.7, 1), 2, used)
    ];

    return { ok: true, list: menu };
  }

  /* --------------------------------------------- 今日进食账本（进程内状态） */

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  /** 跨零点自动归零的一份当日账本。 */
  _ledger() {
    const key = this._todayKey();
    if (!this._fed || this._fed.date !== key) {
      this._fed = { date: key, kcal: 0, items: [] };
    }
    return this._fed;
  }

  todayIntake() {
    const l = this._ledger();
    return { date: l.date, kcal: l.kcal, items: l.items };
  }

  /**
   * 投喂麦娘。带着真实的营养成分与一句她的反应。
   *
   * 热量账本记在进程内并随日期自动归零：不写 localStorage，
   * 因为在 file:// 协议下 Electron 的 localStorage 并不可靠。
   *
   * @param {string} keyword 餐品名关键词；留空则随机挑一样
   */
  async feed(keyword) {
    const list = await this._nutritionList();
    if (list.length === 0) return { ok: false, message: '营养数据没查到，稍后再试～' };

    let item = null;
    if (keyword) {
      const kw = String(keyword).replace(/\s/g, '');
      item = list.find((it) => it.name.includes(kw)) || list.find((it) => kw.includes(it.name));
    }
    if (!item) item = list[Math.floor(Math.random() * list.length)];

    const level = item.energyKcal >= 600 ? 'heavy' : item.energyKcal >= 350 ? 'mid' : 'light';
    let comment;
    if (level === 'heavy') comment = `${item.energyKcal} 大卡…这个下肚，我今天算白走了。`;
    else if (level === 'mid') comment = `${item.energyKcal} 大卡，垫垫肚子刚刚好。`;
    else comment = `才 ${item.energyKcal} 大卡，这个我可以！`;

    this._ledger().kcal += item.energyKcal;
    this._ledger().items.push({ name: item.name, kcal: item.energyKcal });
    const total = this._ledger().kcal;

    // 吃多了她会有意见 —— 这一天积下来才会出现，是慢慢养出来的笑点
    if (total >= 2000) {
      comment += ` 话说…今天我已经吃了 ${total} 大卡了，再喂下去我要跑不动了呀。`;
    } else if (total >= 1200) {
      comment += ` 今天到现在一共 ${total} 大卡了哦。`;
    }

    return {
      ok: true,
      item,
      level,
      todayKcal: total,
      todayItems: this._ledger().items.length,
      dailyLimit: total >= 2000 ? 'over' : total >= 1200 ? 'high' : 'ok',
      message: `唔…我吃了一口「${item.name}」，${comment}（蛋白 ${item.protein}g / 脂肪 ${item.fat}g / 碳水 ${item.carbohydrate}g）`
    };
  }

  /**
   * 猜热量：从真实营养库里出两款餐品。
   *
   * 出题策略决定题目质量：完全随机会抽出「红茶 vs 双层汉堡」这种常识题，
   * 所以这里先把库按热量排序，再在邻近区间里找对手 —— 差距控制在 20~220 大卡，
   * 既不至于一眼看穿，也不至于变成纯运气。
   */
  async calorieQuiz() {
    const list = await this._nutritionList();
    if (list.length < 2) return { ok: false, message: '营养数据不够出一道题。' };

    const sorted = [...list].sort((a, b) => a.energyKcal - b.energyKcal);
    const MIN_GAP = 20;
    const MAX_GAP = 220;

    for (let guard = 0; guard < 120; guard += 1) {
      const i = Math.floor(Math.random() * sorted.length);
      const step = 1 + Math.floor(Math.random() * 6);
      const j = Math.min(sorted.length - 1, i + step);
      if (i === j) continue;

      const a = sorted[i];
      const b = sorted[j];
      if (!a || !b) continue;

      const diff = Math.abs(a.energyKcal - b.energyKcal);
      if (diff < MIN_GAP || diff > MAX_GAP) continue;

      // 一半概率左右调换，避免正确答案总是同一侧
      const flip = Math.random() < 0.5;
      const left = flip ? b : a;
      const right = flip ? a : b;

      return {
        ok: true,
        a: left,
        b: right,
        diff,
        answer: left.energyKcal > right.energyKcal ? 'a' : 'b'
      };
    }
    return { ok: false, message: '题库挑不出来，再点一次试试。' };
  }

  /* -------------------------------------------------------------- 扭蛋机 */

  /**
   * 查看当前抽奖活动（只读，绝不抽奖）。
   *
   * 官方协议要求：能否抽奖必须以服务端 drawDecision.resourceEligible 为准，
   * 本次消耗必须以 drawDecision.nextConsumption 为准，且 nextConsumption.text
   * 须在用户确认前原样展示。这里因此把 costText 完整透传，不做任何改写。
   */
  async lotteryInfo() {
    const raw = await this._safe('query-lottery-info');
    if (!raw) return { ok: false, message: '抽奖活动没查到，稍后再试～' };

    const lot = parseLottery(textOf(raw));
    if (!lot.active) {
      return { ok: false, message: lot.statusText || '当前没有进行中的抽奖活动。', info: lot };
    }
    if (!lot.eligible) {
      return {
        ok: false,
        blocked: true,
        info: lot,
        message: `这会儿抽不了：${lot.statusText || '资源不足'}（你有 ${lot.availablePoint} 积分，单次需要 ${lot.drawPoint}）`
      };
    }

    const times = lot.drawPoint > 0 ? Math.floor(lot.availablePoint / lot.drawPoint) : 0;
    return {
      ok: true,
      info: lot,
      message: `现在是「${lot.activityName}」，你有 ${lot.availablePoint} 积分，${lot.drawTypeText}，单次 ${lot.drawPoint} 分——大约还能抽 ${times} 次。`
    };
  }

  /**
   * 真的抽一次。
   *
   * 三重闸门，缺一不可：
   *   1. confirm 必须为 true —— 用户点了带消耗文案的确认按钮才算数；
   *   2. 冷却期内拒绝对话 —— 防连点，也避免把服务端限流变成用户的积分损失；
   *   3. 抽前重新查一次 Eligible —— 防止界面停留太久、积分已被他处扣掉。
   *
   * 失败时 message 直接沿用服务端原文，按协议要求不做改写。
   */
  async drawLottery({ confirm = false } = {}) {
    if (confirm !== true) {
      return { ok: false, needConfirm: true, message: '要你明确点头我才敢按下去，毕竟这一下去是真的扣积分。' };
    }

    const since = Date.now() - (this._lastDrawAt || 0);
    if (since < DRAW_COOLDOWN_MS) {
      const wait = Math.ceil((DRAW_COOLDOWN_MS - since) / 1000);
      return { ok: false, cooling: true, message: `缓一缓呀，${wait} 秒后再抽～` };
    }

    const gate = await this.lotteryInfo();
    if (!gate.ok) return { ok: false, blocked: true, message: gate.message };

    // 标记时间：即使后面失败也计入冷却，避免失败重试风暴
    this._lastDrawAt = Date.now();

    const raw = await this._safe('draw-lottery');
    if (!raw) return { ok: false, message: '抽奖请求没发出去，稍后再试试～' };

    const r = parseDrawResult(textOf(raw));
    if (r.code !== 'SUCCESS') {
      return { ok: false, official: true, message: r.message || '抽奖没有成功。' };
    }
    if (!r.win || r.prizes.length === 0) {
      return { ok: true, win: false, prizes: [], message: '嗯…这次没中奖。积分已经是官方抽奖替你花出去的了，下次再来！' };
    }

    const names = r.prizes.map((p) => p.name).join('、');
    return { ok: true, win: true, prizes: r.prizes, message: `中了！是「${names}」！我的手气还不错吧？` };
  }

  /* ------------------------------------------------------------ 节气收藏册 */

  /**
   * 奖品墙 + 节气图鉴。
   * 实测：query-my-prizes 会返回历史抽奖所得，其中 prizeTypeText 为「门票」且名称恰好是
   * 二十四节气之一的，构成一套天然的收集册。
   */
  async prizeCollection() {
    const raw = await this._safe('query-my-prizes', { pageNum: '1', pageSize: '50' });
    if (!raw) return { ok: false, message: '奖品查询失败，稍后再试～' };

    const list = parsePrizes(textOf(raw));
    const ticketNames = new Set(list.filter((p) => p.type === '门票').map((p) => p.name));

    const owned = SOLAR_TERMS.filter((t) => ticketNames.has(t)).map((t) => {
      const hit = list.find((p) => p.name === t);
      return { name: t, time: hit ? hit.time.slice(0, 10) : '', usable: hit ? hit.usable : false };
    });
    const missing = SOLAR_TERMS.filter((t) => !ticketNames.has(t));

    let message;
    if (owned.length === 0) {
      message = `你抽到过 ${list.length} 件奖品，不过还没有节气门票。下一张说不定就在眼前～`;
    } else if (owned.length === SOLAR_TERMS.length) {
      message = '二十四节气门票全齐了！这也太厉害了吧…';
    } else {
      message = `你已经集到 ${owned.length}/${SOLAR_TERMS.length} 张节气门票啦：${owned.map((o) => o.name).join('、')}。`;
    }

    // 下一个节气还要几天 —— 抽奖是按节气出票的，这个倒计时就是「下次机会还有多久」
    const term = this.snapshot ? this.snapshot.nextTerm : nextSolarTerm(new Date());

    return {
      ok: true,
      total: list.length,
      owned,
      missing,
      all: SOLAR_TERMS,
      recent: list.slice(0, 8),
      nextTerm: term,
      progress: Math.round((owned.length / SOLAR_TERMS.length) * 100),
      message
    };
  }

  get status() {
    return { configured: this.client.configured, snapshot: this.snapshot };
  }
}

module.exports = { PetBrain };
