'use strict';

/**
 * 端到端校验：真实 MCP → 解析器 → 麦娘播报文案。
 * 用法：设置 MCD_MCP_TOKEN 后执行 node scripts/check-brain.js [城市关键词]
 */

const { McpClient } = require('../src/mcp/client.js');
const { PetBrain } = require('../src/mcp/brain.js');

(async () => {
  const token = process.env.MCD_MCP_TOKEN || '';
  if (!token) {
    console.error('未检测到 MCD_MCP_TOKEN');
    process.exit(2);
  }

  const client = new McpClient({ token });
  const brain = new PetBrain(client, {
    onEvent: (e) => console.log(`  [${e.type}] ${e.tool || ''} ${e.message || ''}`)
  });

  console.log('=== refresh 快照 ===');
  const s = await brain.refresh();
  console.log(JSON.stringify({
    wallet: { total: s.wallet.total, expiringToday: s.wallet.expiringToday, sample: s.wallet.list.slice(0, 3).map((c) => `${c.name}(${c.price}) 到期:${c.expiry} 标签:${c.tags.join('/')}`) },
    claimable: { total: s.claimable.total, sample: s.claimable.list.slice(0, 3).map((c) => c.title) },
    points: s.points,
    campaigns: { serverTime: s.campaigns.serverTime, todayCount: s.campaigns.todayCount, todayTitles: s.campaigns.todayTitles, upcomingCount: s.campaigns.upcomingCount, upcomingTitles: s.campaigns.upcomingTitles },
    orders: { total: s.orders.total, latest: s.orders.latest && { time: s.orders.latest.createTime, store: s.orders.latest.storeName, amount: s.orders.latest.amount, products: s.orders.latest.products }, daysSinceLast: s.orders.daysSinceLast, topProducts: s.orders.topProducts }
  }, null, 2));

  console.log('\n=== 定时播报 ===');
  console.log(brain.buildBriefing());

  console.log('\n=== 各项播报 ===');
  const reports = [
    ['券盘点', () => brain.couponReport()],
    ['积分', () => brain.pointsReport()],
    ['活动', () => brain.campaignReport()],
    ['订单', () => brain.orderReport()],
    ['门店', () => brain.storeReport({ city: process.argv[2] || '上海市', keyword: process.argv[3] || '陆家嘴' })],
    ['营养-巨无霸', () => brain.nutritionLookup('巨无霸')],
    ['营养-麦香鱼', () => brain.nutritionLookup('麦香鱼')]
  ];

  for (const [label, fn] of reports) {
    process.stdout.write(`▶ ${label} … `);
    try {
      const r = await fn();
      console.log(r.ok ? '' : '(失败)');
      console.log(`  ${r.message}`);
    } catch (err) {
      console.log(`异常：${err.message}`);
    }
  }
})().catch((err) => {
  console.error('致命错误：', err.message);
  process.exit(1);
});
