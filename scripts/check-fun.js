'use strict';

/**
 * 趣味性能力联调脚本（只读 + 闸门校验）。
 *
 * 刻意不调用真实的 draw-lottery：抽奖会实实在在扣积分，
 * 本脚本只验证「不确认时必定被拒绝」这道闸门是有效的。
 *
 * 用法：
 *   export MCD_MCP_TOKEN=xxx
 *   node scripts/check-fun.js
 */

const { McpClient } = require('../src/mcp/client.js');
const { PetBrain } = require('../src/mcp/brain.js');

const line = (s) => console.log(`\n${'─'.repeat(64)}\n${s}`);

(async () => {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) {
    console.error('请先设置环境变量 MCD_MCP_TOKEN');
    process.exit(1);
  }

  const client = new McpClient({ token });
  const brain = new PetBrain(client, {
    onEvent: (e) => { if (e.type === 'tool-error') console.warn(`  [tool-error] ${e.tool}: ${e.message}`); }
  });

  console.log('[check] initialize 握手…');
  await client.listTools();
  console.log('[check] 握手成功');

  line('▶ 抽奖活动（只读）');
  const lot = await brain.lotteryInfo();
  console.log('  ok:', lot.ok, '| blocked:', Boolean(lot.blocked));
  console.log('  message:', lot.message);
  if (lot.info) {
    const i = lot.info;
    console.log(`  活动=${i.activityName} 状态=${i.activityStatusText}`);
    console.log(`  单次=${i.drawPoint} 可用积分=${i.availablePoint} 规则=${i.drawTypeText}`);
    console.log(`  eligible=${i.eligible} | 官方消耗原文="${i.costText}"`);
    console.log(`  奖品池 ${i.prizes.length} 项：`, i.prizes.slice(0, 5).map((p) => p.name).join('、'));
  }

  line('▶ 抽奖闸门：不做确认时必须被拒绝（此调用绝不扣积分）');
  const gate = await brain.drawLottery({ confirm: false });
  console.log('  ok:', gate.ok, '| needConfirm:', gate.needConfirm);
  console.log('  message:', gate.message);
  console.log(gate.ok === false ? '  ✅ 闸门有效' : '  ❌ 闸门失效，风险！');

  line('▶ 节气收藏册');
  const col = await brain.prizeCollection();
  console.log(`  奖品总数=${col.total} 已收集=${col.owned.length}/24 进度=${col.progress}%`);
  console.log('  已集齐：', col.owned.map((o) => `${o.name}(${o.time})`).join('、') || '（无）');
  console.log('  还缺：', col.missing.length, '张');
  console.log('  message:', col.message);
  if (col.nextTerm) {
    console.log(`  下一个节气：「${col.nextTerm.name}」还有 ${col.nextTerm.days} 天（${col.nextTerm.month}-${col.nextTerm.day}）`);
  }

  line('▶ 今日菜单（真实营养数据）');
  const menu = await brain.menuOptions();
  if (menu.ok) {
    for (const it of menu.list) {
      console.log(`  ${it.energyKcal} 大卡  ${it.name}  (蛋白 ${it.protein}g)`);
    }
  } else {
    console.log('  ', menu.message);
  }

  line('▶ 投喂');
  const fed = await brain.feed(null);
  console.log('  ', fed.message, '| level =', fed.level);

  line('▶ 猜热量');
  const quiz = await brain.calorieQuiz();
  if (quiz.ok) {
    console.log(`  A: ${quiz.a.name}    B: ${quiz.b.name}`);
    console.log(`  答案 = ${quiz.answer}  →  ${quiz.a.energyKcal} vs ${quiz.b.energyKcal} 大卡`);
  } else {
    console.log('  ', quiz.message);
  }

  console.log('\n[check] 全部完成\n');
})().catch((err) => {
  console.error('[check] 失败：', err);
  process.exit(1);
});
