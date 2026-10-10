'use strict';

/**
 * 麦当劳 MCP 真实调用验证器。
 *
 * 用法：
 *   node scripts/verify-mcp.js list                    # 拉取并打印 Tool 清单与入参 schema
 *   node scripts/verify-mcp.js calls <calls.json>      # 按 JSON 描述逐个真实调用
 *
 * Token 从环境变量 MCD_MCP_TOKEN 读取，脚本内不做任何持久化。
 * 原始响应会写入 .tmp/（已在 .gitignore 中排除），便于离线比对响应格式。
 */

const fs = require('fs');
const path = require('path');
const { McpClient, McpError } = require('../src/mcp/client.js');

const TOKEN = process.env.MCD_MCP_TOKEN || '';
const OUT_DIR = path.join(__dirname, '..', '.tmp');

/**
 * 会不可逆消耗用户资产的工具，验证脚本一律拒绝执行。
 *
 * draw-lottery 每调用一次就真实扣除用户积分，且官方协议明确要求
 * 「必须先展示消耗说明并取得用户明确确认」「严禁试抽」。
 * 把工具名写进 JSON 清单就能触发扣分，风险太高 —— 所以这里做硬拦截，
 * 而不是依赖使用者记得别写进去。
 */
const BLOCKED_TOOLS = new Set(['draw-lottery']);

function preview(value, limit = 600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n…（省略 ${text.length - limit} 字符）` : text;
}

function schemaOf(tool) {
  const s = tool.inputSchema || {};
  const props = s.properties || {};
  return Object.entries(props).map(([k, v]) => {
    const flag = (s.required || []).includes(k) ? '*' : '';
    return `${k}${flag}:${v.type || 'any'}`;
  }).join(', ') || '(无入参)';
}

async function phaseList() {
  const client = new McpClient({ token: TOKEN });
  await client.initialize();
  console.log('[verify] initialize 握手成功');

  const tools = await client.listTools();
  console.log(`[verify] 共 ${tools.length} 个 Tool\n`);

  for (const t of tools) {
    console.log(`● ${t.name}`);
    if (t.description) console.log(`  说明：${t.description.replace(/\s+/g, ' ').slice(0, 120)}`);
    console.log(`  入参：${schemaOf(t)}`);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'mcp-tools.json');
  fs.writeFileSync(file, JSON.stringify(tools, null, 2), 'utf8');
  console.log(`\n[verify] 完整 schema 已写入 ${file}`);
}

async function phaseCalls(callsFile) {
  const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
  const client = new McpClient({ token: TOKEN });
  await client.initialize();
  console.log('[verify] initialize 握手成功\n');

  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const call of calls) {
    const label = call.name;
    process.stdout.write(`▶ ${label} … `);

    if (BLOCKED_TOOLS.has(call.name)) {
      skipped += 1;
      console.log('已跳过（该工具会真实消耗用户资产，验证脚本不代劳）');
      console.log('');
      continue;
    }

    try {
      const data = await client.callTool(call.name, call.args || {});
      ok += 1;
      console.log('成功');
      console.log(preview(data, call.limit || 700));
      if (call.save && !fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
      }
      if (call.save) {
        const dest = path.join(OUT_DIR, call.save);
        fs.writeFileSync(dest, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
        console.log(`  → 原始响应已保存 ${dest}`);
      }
    } catch (err) {
      fail += 1;
      const code = err instanceof McpError ? ` [${err.code}]` : '';
      console.log(`失败${code}：${err.message}`);
    }
    console.log('');
  }

  console.log(`[verify] 汇总：成功 ${ok} / 失败 ${fail}${skipped ? ` / 跳过 ${skipped}` : ''}  / 合计 ${calls.length}`);
}

(async () => {
  const phase = process.argv[2] || 'list';

  if (!TOKEN) {
    console.error('[verify] 未检测到 MCD_MCP_TOKEN 环境变量');
    process.exit(2);
  }
  console.log(`[verify] Token 已载入（长度 ${TOKEN.length}，前缀 ${TOKEN.slice(0, 4)}…）`);

  if (phase === 'list') {
    await phaseList();
  } else if (phase === 'calls') {
    if (!process.argv[3]) {
      console.error('[verify] 缺少调用描述文件路径');
      process.exit(2);
    }
    await phaseCalls(process.argv[3]);
  } else {
    console.error(`[verify] 未知阶段：${phase}`);
    process.exit(2);
  }
})().catch((err) => {
  const code = err instanceof McpError ? ` [${err.code}]` : '';
  console.error(`[verify] 致命错误${code}：${err.message}`);
  process.exit(1);
});
