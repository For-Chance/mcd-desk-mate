'use strict';

/**
 * 麦当劳 MCP 响应解析器。
 *
 * ⚠️ 实测结论（2026-10 真实调用）：MCP 各 Tool 返回的 content 是 **Markdown 文本**，
 * 而不是结构化 JSON。大致有两类形态：
 *
 *   A. 纯 Markdown 报告：available-coupons / query-my-coupons / campaign-calendar /
 *      auto-bind-coupons —— 业务数据全在文本行里，没有 JSON；
 *   B. Markdown 说明 + 内嵌一段原始 JSON：query-my-account / order-list /
 *      list-nutrition-foods / query-nearby-stores —— JSON 出现在文末，需要挖出来。
 *      其中营养接口更特殊，JSON 的 data 字段本身又是 "[N]{字段列表}:\\n  行1\\n  行2" 的自定义表格串。
 *
 * 因此这里统一把文本转成干净的 JS 对象，供上层使用；解析失败一律返回空集合，不抛异常。
 */

/* ------------------------------------------------------------ 通用工具 */

const num = (v, fallback = 0) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

/** 从 Markdown 包装的文本里挖出内嵌的那段 JSON 对象。 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 取内嵌 JSON 里的业务数据体，优先 data 字段。 */
function payloadOf(text) {
  const root = extractJson(text);
  if (!root) return null;
  if (root.data !== undefined) return root.data;
  return root;
}

/* ------------------------------------------------------- query-my-account */

function parseAccount(text) {
  const data = payloadOf(text);
  if (!data || typeof data !== 'object') {
    return { available: 0, accumulative: 0, expiringThisMonth: 0, expiringNextMonth: 0, currency: '' };
  }
  return {
    available: num(data.availablePoint),
    accumulative: num(data.accumulativePoint),
    expiringThisMonth: num(data.currentMouthExpirePoint),
    expiringNextMonth: num(data.nextMouthExpirePoint),
    frozen: num(data.frozenPoint),
    used: num(data.usedPoint),
    currency: data.currency || '积分'
  };
}

/* ------------------------------------------------------ available-coupons */

// 形如：
// ### 麦麦省优惠券列表：
// - 优惠券标题：麦旋风任选 \
//   状态：可领取 \
//   优惠券图片：\
//     <img src="...">
function parseClaimable(text) {
  if (typeof text !== 'string') return [];
  const re = /优惠券标题：([^\n\\]+)\\?\s*\n\s*状态：([^\n\\]+)\\?/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ title: m[1].trim(), status: m[2].trim() });
  }
  return out;
}

/* ------------------------------------------------------ query-my-coupons */

// 形如：
// # 您的优惠券列表
// 共 8 张可用优惠券 | 第 1/1 页 | 每页 20 条
// ## 9.9元中杯冰美式
// - **优惠**: ¥9.9 (用券价格)
// - **有效期**: 2026-10-09 00:00-2026-10-15 23:59
// - **领取时间**: 今日收到
// - **标签**: 到店专用、外送专用
function parseWallet(text) {
  if (typeof text !== 'string') return { total: 0, list: [] };

  const list = [];
  const sections = text.split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const lines = sec.split(/\r?\n/);
    const name = (lines[0] || '').trim();
    if (!name) continue;

    const body = lines.slice(1).join('\n');
    const field = (key) => {
      const m = body.match(new RegExp(`-\\s*\\*\\*${key}\\*\\*[:：]\\s*(.+)`));
      return m ? m[1].trim() : '';
    };
    const tags = field('标签').split(/[、,，]/).map((s) => s.trim()).filter(Boolean);

    list.push({
      name,
      price: field('优惠'),
      expiry: field('有效期'),
      receivedAt: field('领取时间'),
      tags,
      expiringToday: tags.includes('今日到期') || /今日到期/.test(field('标签'))
    });
  }

  const declared = text.match(/共\s*(\d+)\s*张/);
  const total = declared ? Number(declared[1]) : list.length;

  return { total: total || list.length, list };
}

/* ----------------------------------------------------- campaign-calendar */

// 形如：
// ### 当前时间：2026-10-09 23:56:37
// #### 2026年10月9日 今日
// -   **活动标题**：xxx
//     **活动内容介绍**：多行文案
function parseCampaigns(text) {
  if (typeof text !== 'string') return { serverTime: '', blocks: [], items: [] };

  const timeMatch = text.match(/当前时间[：:]\s*([0-9:\-\s]+)/);
  const items = [];
  const blocks = [];

  const chunks = text.split(/^####\s+/m).slice(1);
  for (const chunk of chunks) {
    const head = (chunk.split(/\r?\n/)[0] || '').trim();
    const date = (head.match(/^\d{4}年\d{1,2}月\d{1,2}日/) || [''])[0];
    const label = head.replace(date, '').trim();
    const entries = [];
    const re = /-\s+\*\*活动标题\*\*[：:]([^\n]+)\n\s*\*\*活动内容介绍\*\*[：:]([\s\S]*?)(?=\n\s*\n|\n-\s+\*\*活动标题|\n####|$)/g;
    let m;
    while ((m = re.exec(chunk)) !== null) {
      const content = m[2].replace(/<img[^>]*>/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
      entries.push({ title: m[1].trim(), content });
      items.push({ date, label, title: m[1].trim(), content });
    }
    blocks.push({ date, label, count: entries.length, entries });
  }

  return { serverTime: timeMatch ? timeMatch[1].trim() : '', blocks, items };
}

/* ------------------------------------------------------------- order-list */

function parseOrders(text) {
  const data = payloadOf(text);
  if (!data) return [];
  const list = Array.isArray(data) ? data : Array.isArray(data.list) ? data.list : [];
  return list.map((o) => ({
    orderId: o.orderId || '',
    orderType: o.orderType || '',
    createTime: o.createTime || '',
    storeName: o.storeName || '',
    storeCode: o.storeCode || '',
    status: o.orderStatus || '',
    amount: num(o.realTotalAmount),
    products: (Array.isArray(o.orderProductList) ? o.orderProductList : []).flatMap((p) => {
      const combos = Array.isArray(p.comboItemList) ? p.comboItemList.map((c) => c.name) : [];
      return [p.productName, ...combos].filter(Boolean);
    })
  }));
}

/* --------------------------------------------------- list-nutrition-foods */

// JSON 里的 data 是自定义表格串：
// "[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  猪柳麦满分,null,1288,308,..."
function parseNutrition(text) {
  const data = payloadOf(text);
  if (typeof data !== 'string') return [];

  const headEnd = data.indexOf(':\n');
  if (headEnd < 0) return [];

  const head = data.slice(0, headEnd);
  const fieldMatch = head.match(/\{([^}]*)\}/);
  if (!fieldMatch) return [];
  const fields = fieldMatch[1].split(',').map((s) => s.trim());

  return data.slice(headEnd + 2).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    fields.forEach((f, i) => { row[f] = cells[i] ?? ''; });
    return {
      name: row.productName || '',
      energyKcal: num(row.energyKcal),
      energyKj: num(row.energyKj),
      protein: num(row.protein),
      fat: num(row.fat),
      carbohydrate: num(row.carbohydrate),
      sodium: num(row.sodium),
      calcium: num(row.calcium)
    };
  }).filter((r) => r.name && r.name !== 'null');
}

/* ---------------------------------------------------- query-nearby-stores */

function parseStores(text) {
  const root = extractJson(text);
  if (!root) return { list: [], error: '' };
  if (root.success === false) {
    return { list: [], error: root.message || '查询失败' };
  }
  const data = Array.isArray(root.data) ? root.data : [];
  return {
    error: '',
    list: data.map((s) => ({
      storeCode: s.storeCode || '',
      storeName: s.storeName || '',
      address: s.address || '',
      distance: num(s.distance),
      open: Boolean(s.businessStatus),
      businessHours: s.businessStartTime && s.businessEndTime ? `${s.businessStartTime}-${s.businessEndTime}` : '',
      reservation: Boolean(s.reservation)
    }))
  };
}

/* ------------------------------------------------------ auto-bind-coupons */

// ### 领券结果
// 总计: 9 张优惠券
// 成功: 9 张
// 失败: 0 张
function parseClaimResult(text) {
  if (typeof text !== 'string') return { total: 0, success: 0, failed: 0, names: [] };
  const pick = (key) => {
    const m = text.match(new RegExp(`${key}[:：]\\s*(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  const names = [];
  const detail = text.split(/####\s*成功领取的优惠券[：:]?/)[1];
  if (detail) {
    for (const line of detail.split(/\r?\n/)) {
      const m = line.match(/^-\s+(.+)$/);
      if (m && !/^\s*-\s*(couponId|couponCode|图片)/.test(m[1]) && !m[1].includes('couponId')) {
        names.push(m[1].trim());
      }
    }
  }
  return { total: pick('总计'), success: pick('成功'), failed: pick('失败'), names };
}

/* ------------------------------------------------------ query-lottery-info */

// 与 order-list 同构：Markdown 外包装 + 内嵌 {success, code, data:{...}}。
// 字段详见 MCP_INTEGRATION.md。这里只做形状归一，不做业务判断，
// 尤其 nextConsumption.text 必须原样透传给上层展示（官方协议要求未经改写地告知用户）。
function parseLottery(text) {
  const empty = {
    active: false, statusCode: '', statusText: '',
    activityName: '', activityStatusText: '', beginTime: '', endTime: '',
    drawPoint: 0, drawTypeText: '', availablePoint: 0,
    eligible: false, costText: '', costType: '', costPoints: 0, costChances: 0,
    prizes: []
  };

  const data = payloadOf(text);
  if (!data || typeof data !== 'object') return empty;

  const status = data.status || {};
  const decision = data.drawDecision || {};
  const next = decision.nextConsumption || {};
  const prizes = Array.isArray(data.prizes)
    ? data.prizes
        .map((p) => ({ name: p.name || '', image: p.imageUrl || '', type: p.typeText || '' }))
        .filter((p) => p.name)
    : [];

  return {
    active: status.code === 'SUCCESS',
    statusCode: status.code || '',
    statusText: status.message || '',
    activityName: data.activityName || '',
    activityStatusText: data.activityStatusText || '',
    beginTime: data.beginTime || '',
    endTime: data.endTime || '',
    drawPoint: num(data.drawPoint),
    drawTypeText: data.drawTypeText || '',
    availablePoint: num(data.availablePoint),
    // 能否抽奖一律以服务端 drawDecision 为准，不得用 availablePoint 自行推算
    eligible: Boolean(decision.resourceEligible),
    costText: next.text || '',
    costType: next.type || '',
    costPoints: num(next.points),
    costChances: Number(next.chances) || 0,
    prizes
  };
}

/* --------------------------------------------------------- draw-lottery */

// 抽奖结果。status.code 非 SUCCESS 时，message 是官方给的具体失败原因，
// 按协议要求必须原样展示给用户，禁止自行改写。
function parseDrawResult(text) {
  const data = payloadOf(text);
  if (!data || typeof data !== 'object') {
    return { code: '', message: '没有拿到抽奖结果', win: false, prizes: [] };
  }

  const status = data.status || {};
  const prizes = Array.isArray(data.prizes)
    ? data.prizes
        .map((p) => ({
          name: p.name || '',
          image: p.imageUrl || p.image || '',
          type: p.typeText || '',
          valid: p.validDateInfo || ''
        }))
        .filter((p) => p.name)
    : [];

  return {
    code: status.code || '',
    message: status.message || '',
    win: Boolean(data.win),
    prizes
  };
}

/* -------------------------------------------------------- query-my-prizes */

// 奖品墙：{ data: { status, prizes: [{ id, name, prizeTypeText, recordTime, statusText, imageUrl }] } }
function parsePrizes(text) {
  const data = payloadOf(text);
  if (!data || typeof data !== 'object') return [];

  const list = Array.isArray(data.prizes) ? data.prizes : Array.isArray(data.list) ? data.list : [];
  return list.map((p) => ({
    id: p.id || '',
    name: p.name || '',
    image: p.imageUrl || p.image || '',
    type: p.prizeTypeText || p.typeText || '',
    status: p.statusText || '',
    usable: p.statusText === '可用',
    time: p.recordTime || p.createTime || '',
    timeRemind: p.timeRemindText || '',
    source: p.sourceDesc || ''
  })).filter((p) => p.name);
}

/* --------------------------------------------------------- now-time-info */

// 服务端时间。用它的意义在于：作息判断不能相信客户端时钟 ——
// 用户机器时间可能是错的，那她「现在是早餐时段」就会说得莫名其妙。
function parseServerTime(text) {
  const data = payloadOf(text);
  if (!data || typeof data !== 'object') return null;
  return {
    timestamp: Number(data.timestamp) || 0,
    formatted: data.formatted || '',
    date: data.date || '',
    year: Number(data.year) || 0,
    month: Number(data.month) || 0,
    day: Number(data.day) || 0,
    dayOfWeek: data.dayOfWeek || '',
    timezone: data.timezone || ''
  };
}

module.exports = {
  extractJson,
  payloadOf,
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
  parseServerTime,
  num
};
