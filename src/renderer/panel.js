'use strict';

/**
 * 玩法面板：扭蛋机 / 节气收藏册 / 投喂 / 猜热量。
 *
 * 所有内容均由 window.mcd.action() 走 IPC 到主进程，再由 PetBrain 调用麦当劳 MCP，
 * 面板自身不持有任何凭证，也不自行构造网络请求。
 *
 * 关于扭蛋机的合规性：官方 MCP 协议要求调用 draw-lottery 前，必须向用户展示
 * drawDecision.nextConsumption 原文并取得明确确认；失败时必须原样展示服务端 message。
 * 这两条在这里落在 UI 上，不是注释里的口号 —— 见 renderGacha 与 doDraw。
 */

const bridge = window.mcd || {};
const view = document.getElementById('view');
const tabs = [...document.querySelectorAll('.tab')];

let mode = new URLSearchParams(location.search).get('mode') || 'gacha';
let gachaData = null;
let drawing = false;
let quizData = null;
let streak = 0;
let intake = { kcal: 0, items: 0 };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

async function call(name, payload = {}) {
  if (!bridge.action) return { ok: false, message: '桥接未就绪' };
  try {
    return await bridge.action(name, payload);
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function setMode(next) {
  mode = next;
  tabs.forEach((t) => t.classList.toggle('on', t.dataset.mode === next));
  route();
}

/* ---------------------------------------------------------------- 扭蛋机 */

async function renderGacha() {
  view.innerHTML = '<p class="loading">正在查看抽奖活动…</p>';
  const res = await call('gacha');

  if (!res.ok) {
    view.innerHTML = `
      <div class="card">
        <div class="card-title">扭蛋机暂停营业</div>
        <p class="muted">${esc(res.message)}</p>
      </div>
      <p class="hint">能不能抽奖由服务端 <b>drawDecision.resourceEligible</b> 说了算，我不会自行判断积分够不够。
      积分不足时这里会如实告知，不会把按钮藏起来。</p>`;
    gachaData = null;
    return;
  }

  const lot = res.info || {};
  gachaData = res;
  const times = lot.drawPoint > 0 ? Math.floor(lot.availablePoint / lot.drawPoint) : 0;

  const prizes = (lot.prizes || []).map((p) => `
    <div class="prize">
      ${p.image ? `<img src="${esc(p.image)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="pname">${esc(p.name)}</div>
      <div class="ptype">${esc(p.type)}</div>
    </div>`).join('');

  view.innerHTML = `
    <div class="card">
      <div class="card-title">${esc(lot.activityName)}</div>
      <p class="muted">${esc(lot.activityStatusText)}${lot.endTime ? ` · 至 ${esc(lot.endTime.slice(0, 10))}` : ''}</p>
      <div class="stat-row">
        <div class="stat"><b>${lot.availablePoint}</b><span>可用积分</span></div>
        <div class="stat"><b>${lot.drawPoint}</b><span>单次所需</span></div>
        <div class="stat"><b>${times}</b><span>约可抽次数</span></div>
      </div>
      <p class="muted">${esc(lot.drawTypeText)}</p>
    </div>

    <div class="official">
      <span class="tag">官方说明</span>
      <span>${esc(lot.costText || '（服务端未返回消耗说明）')}</span>
    </div>

    <div id="gacha-stage">
      <div id="egg"><div class="shell"></div></div>
      <p class="status">扭啊扭…</p>
    </div>

    <div id="win-card">
      <div id="win-body"></div>
    </div>

    <div class="btn-row">
      <button class="btn ghost" id="re-check" type="button">重新查看</button>
      <button class="btn primary" id="do-draw" type="button">确认消耗 ${lot.drawPoint} 积分抽一次</button>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-title">奖品池 · ${(lot.prizes || []).length} 项</div>
      <p class="muted">全部取自 <b>query-lottery-info</b> 返回的真实奖品列表</p>
      <div class="prizes-wrap"><div class="prizes">${prizes}</div></div>
    </div>

    <p class="hint">这一步会真的从你的麦当劳积分里扣 ${lot.drawPoint} 分。点下去之前按钮文案写的就是实际代价，
    我不会自动抽，也不会连着抽 —— 官方明确禁止。</p>`;

  view.scrollTop = 0;
  document.getElementById('do-draw').addEventListener('click', doDraw);
  document.getElementById('re-check').addEventListener('click', renderGacha);
}

async function doDraw() {
  if (drawing) return;
  drawing = true;

  const stage = document.getElementById('gacha-stage');
  const egg = document.getElementById('egg');
  const status = stage.querySelector('.status');
  const btn = document.getElementById('do-draw');

  btn.disabled = true;
  stage.classList.add('on');
  document.getElementById('win-card').classList.remove('on');
  egg.classList.remove('drop');
  egg.classList.add('shaking');
  status.textContent = '扭啊扭…这一下会真的扣积分。';

  const res = await call('draw', { confirm: true });

  egg.classList.remove('shaking');
  egg.classList.add('drop');

  const card = document.getElementById('win-card');
  const body = document.getElementById('win-body');

  if (!res.ok) {
    // 协议要求：非 SUCCESS 时服务端 message 就是给用户的答复，原样呈现，不改写
    status.textContent = '没能抽成';
    body.innerHTML = `
      <div class="wname" style="color:#ff9d92">抽奖没有完成</div>
      <div class="wvalid" style="margin-top:8px;line-height:1.7">${esc(res.message)}</div>`;
    card.classList.add('on');
    drawing = false;
    btn.disabled = false;
    return;
  }

  if (!res.win) {
    status.textContent = '转出来了，是空的…';
    body.innerHTML = `
      <div class="wname">这次没中奖</div>
      <div class="wvalid">积分已经按抽奖规则花掉了。要不要缓缓再来一次？</div>`;
    card.classList.add('on');
    if (bridge.perform) bridge.perform('think', 2600);
    if (bridge.say) bridge.say('唔…这次什么都没扭出来，积分倒是真少了，对不起呀。', 'think');
    drawing = false;
    btn.disabled = false;
    await refreshIntake();
    return;
  }

  const p = (res.prizes || [])[0] || {};
  status.textContent = '咔哒——开了！';
  body.innerHTML = `
    ${p.image ? `<img src="${esc(p.image)}" alt="" onerror="this.style.display='none'">` : ''}
    <div class="wname">${esc(p.name)}</div>
    <div class="wtype">${esc(p.type || '')}</div>
    ${p.valid ? `<div class="wvalid">${esc(p.valid)}</div>` : ''}`;
  card.classList.add('on');

  if (bridge.perform) bridge.perform('happy', 3000);
  if (bridge.say) bridge.say(`恭喜呀，扭出来的是「${p.name}」！`, 'happy');

  drawing = false;
  btn.disabled = false;
  // 抽完积分必然变化，顺手把下一次的可用性刷新回来
  setTimeout(renderGacha, 2600);
}

/* ---------------------------------------------------------------- 收藏册 */

async function renderCollection() {
  view.innerHTML = '<p class="loading">正在翻你的奖品柜…</p>';
  const res = await call('collection');

  if (!res.ok) {
    view.innerHTML = `<div class="card"><div class="card-title">翻不动了</div><p class="muted">${esc(res.message)}</p></div>`;
    return;
  }

  const ownedMap = new Map((res.owned || []).map((o) => [o.name, o]));
  const cells = (res.all || []).map((t) => {
    const hit = ownedMap.get(t);
    if (hit) {
      // 只留月-日，6 列布局下格子窄，年份会挤成两行
      const md = hit.time ? hit.time.slice(5) : '';
      return `<div class="cell has">${esc(t)}<span class="cdate">${esc(md)}</span></div>`;
    }
    return `<div class="cell">${esc(t)}</div>`;
  }).join('');

  const recent = (res.recent || []).map((p) => `
    <div class="row">
      <span class="rname">${esc(p.name)}</span>
      <span class="rmeta">${esc(p.type)} · ${esc(p.status)}${p.time ? ` · ${esc(p.time.slice(0, 10))}` : ''}</span>
    </div>`).join('');

  view.innerHTML = `
    <div class="card">
      <div class="card-title">节气门票收藏册</div>
      <p class="muted">麦当劳的抽奖奖品里有一批以节气命名的门票，久而久之就凑成了一整套图鉴。</p>
      <div class="progress"><i style="width:${res.progress}%"></i></div>
      <p class="muted">已集齐 <span class="hl">${res.owned.length} / 24</span>（${res.progress}%），奖品柜里一共 ${res.total} 件战利品。</p>
      ${res.nextTerm ? `<p class="muted">下一个节气「${esc(res.nextTerm.name)}」还有 <span class="hl">${res.nextTerm.days}</span> 天 —— 门票是按节气出的，那就是下一次机会。</p>` : ''}
    </div>

    <div class="grid24">${cells}</div>

    ${recent ? `<div class="card recent"><div class="card-title">最近抽到的</div>${recent}</div>` : ''}

    <div class="btn-row"><button class="btn ghost" id="re-c" type="button">刷新</button></div>
    <p class="hint">金色的是已经在你账户里的，灰色是还差着的。每张都带着真实的获得日期，来自 <b>query-my-prizes</b>。</p>`;

  document.getElementById('re-c').addEventListener('click', renderCollection);
}

/* ------------------------------------------------------------------ 投喂 */

async function refreshIntake() {
  const res = await call('status');
  return res && res.snapshot ? res.snapshot : null;
}

async function renderFeed() {
  view.innerHTML = '<p class="loading">正在从官方营养表里挑菜…</p>';
  const res = await call('menu');

  if (!res.ok || !res.list) {
    view.innerHTML = `<div class="card"><div class="card-title">今天先饿着吧</div><p class="muted">${esc(res.message)}</p></div>`;
    return;
  }

  const pct = Math.min(100, Math.round((intake.kcal / 2000) * 100));
  const dishes = res.list.map((it, i) => `
    <button class="dish" type="button" data-name="${esc(it.name)}" data-i="${i}">
      <div class="dname">${esc(it.name)}</div>
      <div class="dkcal">${it.energyKcal}<em>大卡</em></div>
      <div class="dmeta">蛋白 ${it.protein}g · 脂肪 ${it.fat}g · 碳水 ${it.carbohydrate}g</div>
    </button>`).join('');

  view.innerHTML = `
    <div class="card">
      <div class="card-title">今日进食账本</div>
      <p class="muted">已喂 <span class="hl">${intake.kcal}</span> 大卡 · 共 ${intake.items} 口 · 参考线 2000 大卡</p>
      <div class="intake"><i style="width:${pct}%"></i></div>
    </div>

    <div class="card">
      <div class="card-title">今日菜单</div>
      <p class="muted">从 <b>list-nutrition-foods</b> 的 160 条真实营养数据里，按热量分轻食 / 常规 / 硬菜三档各挑两样。</p>
      <div class="menu">${dishes}</div>
    </div>

    <div id="reaction-box"></div>

    <p class="hint">点一下就把这口喂给她吃 —— 热量是真数据，她也会真记着今天吃了多少，
    超过 1200 大卡会开始嘀咕，过了 2000 就要抱怨跑不动了。</p>`;

  view.querySelectorAll('.dish').forEach((btn) => {
    btn.addEventListener('click', () => doFeed(btn.dataset.name));
  });
}

async function doFeed(name) {
  const box = document.getElementById('reaction-box');
  box.innerHTML = '<p class="loading">她正在吃…</p>';

  const res = await call('feed', { keyword: name });
  if (!res.ok) {
    box.innerHTML = `<div class="card"><p class="muted">${esc(res.message)}</p></div>`;
    return;
  }

  intake = { kcal: res.todayKcal || 0, items: res.todayItems || 0 };

  box.innerHTML = `
    <div class="reaction">
      <span class="lead">${esc(res.item.name)} · ${res.item.energyKcal} 大卡</span>
      ${esc(res.message)}
      <div style="margin-top:10px" class="muted">蛋白 ${res.item.protein}g · 脂肪 ${res.item.fat}g · 碳水 ${res.item.carbohydrate}g · 钠 ${res.item.sodium}mg</div>
      <div style="margin-top:6px" class="muted">今日累计 <span class="hl">${res.todayKcal}</span> 大卡${res.dailyLimit === 'over' ? '（超线了…）' : ''}</div>
    </div>`;

  if (bridge.perform) bridge.perform(res.level === 'heavy' ? 'think' : 'shy', 2800);
  if (bridge.say) bridge.say(res.message, res.level === 'heavy' ? 'think' : 'shy');

  // 让顶部的账本条同步
  const bar = document.querySelector('.intake i');
  const label = document.querySelector('.card .muted');
  if (bar) bar.style.width = `${Math.min(100, Math.round((intake.kcal / 2000) * 100))}%`;
  if (label) {
    label.innerHTML = `已喂 <span class="hl">${intake.kcal}</span> 大卡 · 共 ${intake.items} 口 · 参考线 2000 大卡`;
  }
}

/* ---------------------------------------------------------------- 猜热量 */

async function renderQuiz() {
  view.innerHTML = '<p class="loading">正在从 160 条真实数据里出题…</p>';
  const res = await call('quiz');

  if (!res.ok) {
    view.innerHTML = `<div class="card"><div class="card-title">出题失败</div><p class="muted">${esc(res.message)}</p></div>`;
    return;
  }

  quizData = res;
  view.innerHTML = `
    <div class="card">
      <div class="card-title">哪个热量更高？</div>
      <p class="muted">两个都来自官方营养表。为了保证有悬念，出题时会挑热量接近的对手，差值控制在 20~220 大卡。</p>
      <div class="quiz-pair">
        <button class="opt" id="opt-a" type="button"><div class="oname">${esc(res.a.name)}</div><div class="okcal">${res.a.energyKcal} 大卡</div></button>
        <span class="vs">VS</span>
        <button class="opt" id="opt-b" type="button"><div class="oname">${esc(res.b.name)}</div><div class="okcal">${res.b.energyKcal} 大卡</div></button>
      </div>
      <div class="verdict" id="verdict"></div>
      <div class="streak">当前连胜 <b id="streak-n">${streak}</b> 题</div>
    </div>

    <div class="btn-row"><button class="btn primary" id="next-q" type="button">换一题</button></div>

    <p class="hint">答案没有任何写死的成分 —— 每次都是从真实营养现场抽出来算的。</p>`;

  document.getElementById('opt-a').addEventListener('click', () => answer('a'));
  document.getElementById('opt-b').addEventListener('click', () => answer('b'));
  document.getElementById('next-q').addEventListener('click', renderQuiz);
}

function answer(pick) {
  if (!quizData) return;
  const right = pick === quizData.answer;
  const a = document.getElementById('opt-a');
  const b = document.getElementById('opt-b');

  a.classList.add('reveal');
  b.classList.add('reveal');
  a.disabled = true;
  b.disabled = true;
  (quizData.answer === 'a' ? a : b).classList.add('right');
  (quizData.answer === 'a' ? b : a).classList.add('wrong');

  streak = right ? streak + 1 : 0;
  document.getElementById('streak-n').textContent = streak;

  const diff = Math.abs(quizData.a.energyKcal - quizData.b.energyKcal);
  const winner = quizData.answer === 'a' ? quizData.a : quizData.b;
  document.getElementById('verdict').innerHTML = right
    ? `答对了！「${esc(winner.name)}」更高，${esc(winner.energyKcal)} 大卡，两者只差 <span class="hl">${diff}</span> 大卡。`
    : `差一点点。「${esc(winner.name)}」才是更高的那个，${esc(winner.energyKcal)} 大卡，两者相差 <span class="hl">${diff}</span> 大卡。`;

  if (bridge.perform) bridge.perform(right ? 'happy' : 'think', 2200);
  if (bridge.say) bridge.say(right ? '答对啦！这题我也没把握呢～' : '哎呀，这题挺阴险的，再来一次？', right ? 'happy' : 'think');
}

/* ------------------------------------------------------------------ 路由 */

function route() {
  if (mode === 'gacha') return renderGacha();
  if (mode === 'collection') return renderCollection();
  if (mode === 'feed') return renderFeed();
  if (mode === 'quiz') return renderQuiz();
  view.innerHTML = '<p class="loading">未知模式</p>';
}

tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
document.getElementById('close').addEventListener('click', () => {
  if (bridge.closePanel) bridge.closePanel();
});

if (bridge.onPanelMode) bridge.onPanelMode((m) => setMode(m));

setMode(mode);
