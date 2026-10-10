'use strict';

/**
 * 麦娘的渲染层。
 *
 * 三件事决定了她是不是「活着」：
 *
 *  1. 注视 —— head 层单独跟随鼠标做伪 3D 转动，身体只跟一点点。
 *     这是最有分化能力的一处：她不再是看向前方的贴纸，而是会看你。
 *  2. 物理 —— 拖拽时按横向速度反向倾斜，松手后用弹簧回正并产生过冲。
 *     有重量的东西才像真的存在；刚体平移一眼就穿帮。
 *  3. 意外 —— idle 行为池（东张西望 / 哼歌 / 伸懒腰 / 点头）与打瞌睡，
 *     让她在你没理她的时候也有自己的戏，而不是只在被点击时才动。
 *
 * 关于鼠标穿透：窗口默认「忽略鼠标事件」(forward 模式)，点击会落到下层应用。
 * 渲染层持续做 alpha 命中检测，只有指针真的落在她的不透明像素上才申请接管。
 */

const ASSET = (name) => `../../assets/${name}`;

const EXPRESSIONS = {
  normal: ASSET('mcn-base.png'),
  happy: ASSET('mcn-happy.png'),
  blink: ASSET('mcn-blink.png'),
  think: ASSET('mcn-base.png')
};

/* ------------------------------------------------------------------ 舞蹈 */

/*
 * 为什么舞蹈必须换素材，而不是靠 transform 硬掰
 * ------------------------------------------------------------------
 * 分层 transform 能做呼吸、倾斜、Q 弹、拖拽惯性 —— 这些都是「同一张画
 * 的形变」。但抬手、扭腰、屈膝、腾空改变的是**画本身**：没有哪组仿射变换
 * 能把一只垂着的手臂变成举起来。所以舞蹈只能靠「按节拍换整套关键帧」。
 *
 * 六张姿态帧由 scripts/prepare_dance.py 归一到同一坐标系（帽心对齐、
 * 鞋底共线、头部同尺度），因此切帧时人是**钉在地上**的，只有姿态在变。
 * 这正是「跳舞」与「抽搐」的分界线：坐标系不统一时，每换一帧整个人都会
 * 平移+缩放一下，看着像信号不良。
 *
 * 编排层（这里）只负责三件事：节拍、力度、收尾。
 */

const DANCE_BEAT_MS = 430;

// 一拍一个姿态。lift/squash 是叠在姿态之上的「力度」：
// 下蹲拍往下沉，跳跃拍往上窜 —— 姿态给了造型，节拍给了动能。
const DANCE_ROUTINE = [
  { f: 'd5' },                            // 展臂摆胯
  { f: 'd5' },
  { f: 'd3', fx: '♪' },                   // 胸前比心
  { f: 'd1' },                            // 举手挥手
  { f: 'd4', lift: -7, fx: '✦' },         // 扭腰指天
  { f: 'd5' },
  { f: 'd6', lift: 9, squash: 0.055 },    // 屈膝低拍
  { f: 'd2', lift: -16, fx: '✦' }         // 跳跃 V 字
];

const DANCE_FRAMES = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];

const CLICK_LINES = [
  '要点我右键哦，能做不少事～',
  '双击我，我给你跳一段舞！',
  '要不要试试扭蛋机？我可以帮你抽一次抽奖。',
  '今天想吃点什么呀？我可以喂给你看 (不对，是你喂我)。',
  '我的节气门票还没集齐呢…',
  '记得别让券过期啦。',
  '有活动我也会第一时间告诉你～'
];

const HIT_ALPHA_THRESHOLD = 24;
const HITMAP_SCALE = 0.25;
const DRAG_THRESHOLD = 5;

// 连续这么久没有任何互动就打瞌睡。桌宠最怕烦人，所以她睡着是完全安静的。
const SLEEP_AFTER_MS = 75000;

const petWrap = document.getElementById('pet-wrap');
const petBreathe = document.getElementById('pet-breathe');
const petStack = document.getElementById('pet-stack');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const badge = document.getElementById('badge');
const fx = document.getElementById('fx');

const headLayer = petStack.querySelector('.head');
const bodyLayer = petStack.querySelector('.body');
const legsLayer = petStack.querySelector('.legs');
const layers = [headLayer, bodyLayer, legsLayer];

const bridge = window.mcd || {
  setInteractive() {},
  drag() {},
  action: async () => ({ ok: false, message: '桥接未就绪' }),
  onSpeak() {},
  onPerform() {}
};

/* ------------------------------------------------------------------ 状态 */

let hitMap = null;
let hitW = 0;
let hitH = 0;

let interactive = false;
let expression = 'normal';
let blinkTimer = null;
let bubbleTimer = null;
let expressionTimer = null;
let badgeTimer = null;

let dragging = false;
let pressPoint = null;
let dragOrigin = null;
let dragOffset = null;

let asleep = false;
let lastActivity = Date.now();
let idleBusy = false;
let idleTimer = null;

// 舞蹈状态。dancing 期间换帧权归编排层，眨眼 / idle / 打瞌睡一律让路，
// 否则它们会把姿态帧覆盖掉，舞蹈会闪回站立。
let dancing = false;
let danceTimer = null;
let danceLift = 0;
let danceSquash = 0;

// 物理量。全部用「目标值 + 弹簧逼近」驱动，这样任何变化都不会哐当一下到位。
const phys = {
  tilt: 0, tiltV: 0, tiltTarget: 0,
  lift: 0, liftV: 0, liftTarget: 0,
  squash: 0, squashV: 0, squashTarget: 0,
  spin: 0, spinV: 0, spinTarget: 0
};

// 拖拽速度（px / frame），随鼠标停止会自动衰减回 0
let velX = 0;
let lastMoveX = 0;

// 注视方向，-1..1
const gaze = { x: 0, y: 0 };
const gazeTarget = { x: 0, y: 0 };
let gazeOverride = null; // { x, y, until } —— idle 行为临时接管视线

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------ 命中检测 */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 把立绘降采样成一张 alpha 掩码，用于判断指针是否压在她身上。 */
async function buildHitMap() {
  const img = await loadImage(EXPRESSIONS.normal);
  hitW = Math.max(1, Math.round(img.naturalWidth * HITMAP_SCALE));
  hitH = Math.max(1, Math.round(img.naturalHeight * HITMAP_SCALE));

  const canvas = document.createElement('canvas');
  canvas.width = hitW;
  canvas.height = hitH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, hitW, hitH);

  const { data } = ctx.getImageData(0, 0, hitW, hitH);
  hitMap = new Uint8Array(hitW * hitH);
  for (let i = 0; i < hitMap.length; i += 1) {
    hitMap[i] = data[i * 4 + 3];
  }
}

function hitTest(clientX, clientY) {
  if (!hitMap) return false;

  const rect = petStack.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return false;

  const hx = Math.min(hitW - 1, Math.floor(relX * hitW));
  const hy = Math.min(hitH - 1, Math.floor(relY * hitH));
  return hitMap[hy * hitW + hx] > HIT_ALPHA_THRESHOLD;
}

function updateInteractive(next) {
  if (next === interactive) return;
  interactive = next;
  bridge.setInteractive(next);
}

/* ---------------------------------------------------------------- 表情 */

function applyExpression(name) {
  expression = name;
  const src = EXPRESSIONS[name] || EXPRESSIONS.normal;
  // 三层是同一张立绘的三个切片，换表情必须同时换，否则会出现「头笑身不笑」
  layers.forEach((img) => { img.src = src; });
}

function holdExpression(name, duration) {
  clearTimeout(expressionTimer);
  applyExpression(name);
  expressionTimer = setTimeout(() => {
    if (expression === name) applyExpression('normal');
  }, duration);
}

function scheduleBlink() {
  clearTimeout(blinkTimer);
  const delay = asleep ? 5200 : 2600 + Math.random() * 4200;
  blinkTimer = setTimeout(() => {
    if (expression === 'normal' && !dragging && !asleep && !dancing) {
      applyExpression('blink');
      setTimeout(() => {
        if (expression === 'blink') applyExpression('normal');
      }, 135);
    }
    scheduleBlink();
  }, delay);
}

/* ---------------------------------------------------------------- 舞蹈 */

function preloadDance() {
  DANCE_FRAMES.forEach((id) => {
    const im = new Image();
    im.src = ASSET(`mcn-${id}.png`);
  });
}

/** 换姿态帧。三层是同一张图的切片，必须同时换。 */
function danceFrame(id) {
  expression = 'dance';
  const src = ASSET(`mcn-${id}.png`);
  layers.forEach((img) => { img.src = src; });
}

function stopDance() {
  if (!dancing) return;
  dancing = false;
  clearTimeout(danceTimer);
  danceTimer = null;
  danceLift = 0;
  danceSquash = 0;
  phys.squashV -= 0.04;           // 收势：轻轻一顿
  applyExpression('happy');
  setTimeout(() => {
    if (!dancing && expression === 'happy') applyExpression('normal');
  }, 900);
  scheduleBlink();
}

/**
 * 跳一段。节拍器每拍做两件事：换姿态帧 + 给一次力度脉冲。
 * 首拍刻意留出半个身位的准备感（先沉一下再起势），收尾交给 stopDance。
 */
function startDance(loops = 3) {
  if (dancing) return;
  touchActivity();
  dancing = true;
  idleBusy = true;

  clearTimeout(blinkTimer);
  clearTimeout(idleTimer);
  if (bubble.classList.contains('show')) bubble.classList.remove('show');
  gazeOverride = { x: 0, y: -0.05, until: Date.now() + DANCE_BEAT_MS * DANCE_ROUTINE.length * loops + 900 };

  // 起势
  phys.liftTarget = 0;
  phys.spinTarget = 0;
  phys.squashV -= 0.05;

  const total = DANCE_ROUTINE.length * loops;
  let beat = -1;

  const step = () => {
    if (!dancing) return;
    beat += 1;
    if (beat >= total) {
      idleBusy = false;
      stopDance();
      return;
    }
    const it = DANCE_ROUTINE[beat % DANCE_ROUTINE.length];
    danceFrame(it.f);
    danceLift = it.lift || 0;
    danceSquash = it.squash || 0;
    // 每一拍脚掌落地的那一下顿挫 —— 没有它，换帧只是幻灯片
    phys.squashV -= 0.045 + (it.lift ? 0.02 : 0);
    if (it.fx) spawnFx(it.fx, 'note', 60 + Math.random() * 14, 74 + Math.random() * 12);
    danceTimer = setTimeout(step, DANCE_BEAT_MS);
  };

  physicalDelayStart(step);
}

/** 起势前先压半拍，让第一帧不是「啪」地出现。 */
function physicalDelayStart(step) {
  phys.squashTarget = 0.05;
  danceTimer = setTimeout(() => {
    phys.squashTarget = 0;
    phys.squashV -= 0.06;
    step();
  }, 260);
}

/* ---------------------------------------------------------------- 气泡 */

function showBubble(text, holdMs = 9000, urgent = false) {
  if (!text) return;
  bubbleText.textContent = text;
  bubble.classList.toggle('urgent', Boolean(urgent));
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), holdMs);
}

function showBadge(text, kind, holdMs = 9000) {
  badge.textContent = text;
  badge.className = `show ${kind}${kind === 'urgent' ? ' pulse' : ''}`;
  clearTimeout(badgeTimer);
  if (holdMs > 0) {
    badgeTimer = setTimeout(() => { badge.className = ''; }, holdMs);
  }
}

function hideBadge() {
  clearTimeout(badgeTimer);
  badge.className = '';
}

/* ---------------------------------------------------------------- 粒子 */

function spawnFx(text, kind, xPct = 50, yPct = 88, life = 1700) {
  const el = document.createElement('span');
  el.className = `fx-item ${kind}`;
  el.textContent = text;
  el.style.left = `${xPct}%`;
  el.style.top = `${yPct}%`;
  fx.appendChild(el);
  setTimeout(() => el.remove(), life);
}

/* ------------------------------------------------------------ idle 行为池 */

/**
 * 她在你没理她的时候会自己干点什么。
 * 这是「意外感」的来源：如果她只在被点击时才有反应，本质上还是一张贴图。
 */
function lookAround() {
  const dir = Math.random() < 0.5 ? -1 : 1;
  gazeOverride = { x: dir * (0.55 + Math.random() * 0.45), y: (Math.random() - 0.5) * 0.5, until: Date.now() + 1400 };
}

function hum() {
  holdExpression('blink', 700);
  let n = 0;
  const t = setInterval(() => {
    spawnFx(['♪', '♫', '♩'][n % 3], 'note', 62 + Math.random() * 10, 84 - n * 3);
    n += 1;
    if (n >= 3) clearInterval(t);
  }, 340);
}

function stretch(holdMs) {
  idleBusy = true;
  phys.liftTarget = -7;
  phys.squashTarget = -0.035;
  setTimeout(() => {
    phys.liftTarget = 0;
    phys.squashTarget = 0;
    phys.squashV += 0.05;
    setTimeout(() => { idleBusy = false; }, holdMs ? Math.min(holdMs, 700) : 620);
  }, 620);
}

function nod() {
  const t = Date.now();
  gazeOverride = { x: 0, y: 0.75, until: t + 420 };
  setTimeout(() => { gazeOverride = { x: 0, y: -0.15, until: t + 900 }; }, 430);
}

const IDLES = [
  { name: 'look', weight: 3, run: lookAround },
  { name: 'hum', weight: 2, run: hum },
  { name: 'nod', weight: 2, run: nod },
  { name: 'stretch', weight: 1, run: () => stretch() }
];

function scheduleIdle() {
  clearTimeout(idleTimer);
  const delay = 7000 + Math.random() * 11000;
  idleTimer = setTimeout(() => {
    if (!dragging && !asleep && !idleBusy && !dancing
        && !bubble.classList.contains('show')) {
      const total = IDLES.reduce((n, i) => n + i.weight, 0);
      let r = Math.random() * total;
      for (const item of IDLES) {
        r -= item.weight;
        if (r <= 0) { item.run(); break; }
      }
    }
    scheduleIdle();
  }, delay);
}

/* ---------------------------------------------------------------- 睡眠 */

function goToSleep() {
  if (asleep) return;
  asleep = true;
  petBreathe.classList.add('lazy');
  applyExpression('blink');
  showBadge('Z', 'sleep', 0);
  gazeTarget.x = 0;
  gazeTarget.y = 0.85; // 头微微低下去
  phys.liftTarget = 3; // 身体松懈下沉一点点

  // Z 字慢慢往上飘，但没有任何声音，也不弹任何气泡
  const zzz = setInterval(() => {
    if (!asleep) { clearInterval(zzz); return; }
    spawnFx(Math.random() < 0.5 ? 'z' : 'Z', 'zzz', 64 + Math.random() * 6, 82 - Math.random() * 8, 2100);
  }, 1700);
  window.__mcSleepTimer = zzz;
}

function wakeUp(silent) {
  if (!asleep) return;
  asleep = false;
  clearInterval(window.__mcSleepTimer);
  petBreathe.classList.remove('lazy');
  hideBadge();
  applyExpression('normal');
  phys.liftTarget = 0;
  gazeOverride = null;
  stretch(900);

  if (!silent) {
    holdExpression('happy', 2200);
    showBubble('啊——我、我才没睡着呢！', 4200);
  }
}

function touchActivity() {
  lastActivity = Date.now();
  if (asleep) wakeUp(false);
}

/* ---------------------------------------------------------------- 物理 */

function updatePhysics() {
  // 拖拽速度自然衰减：鼠标停住，她也就不该继续歪着
  velX *= 0.86;

  if (dragging) {
    phys.tiltTarget = clamp(-velX * 1.15, -24, 24);
    phys.liftTarget = -11;
    phys.squashTarget = -0.022;
  } else {
    phys.tiltTarget = 0;
    phys.liftTarget = 0;
    phys.squashTarget = 0;
  }

  // 舞蹈期间由编排层接管纵向位移与挤压 —— 那是「力度」，不是物理惯性
  if (dancing && !dragging) {
    phys.liftTarget = danceLift;
    phys.squashTarget = danceSquash;
  }

  // tilt / lift：临界偏阻尼，快速响应且不抖
  phys.tiltV += (phys.tiltTarget - phys.tilt) * 0.22;
  phys.tiltV *= 0.74;
  phys.tilt += phys.tiltV;

  phys.liftV += (phys.liftTarget - phys.lift) * 0.25;
  phys.liftV *= 0.72;
  phys.lift += phys.liftV;

  // squash：阻尼更轻，刻意让它在回正时过冲一下 —— 那一晃就是「Q 弹」的来源
  phys.squashV += (phys.squashTarget - phys.squash) * 0.3;
  phys.squashV *= 0.68;
  phys.squash += phys.squashV;

  phys.spinV += (phys.spinTarget - phys.spin) * 0.16;
  phys.spinV *= 0.88;
  phys.spin += phys.spinV;
  phys.spinTarget *= 0.94;

  // 注视：一处 <animate>，眼睛跟着鼠标走；idle 行为可以临时接管
  let tx = gazeTarget.x;
  let ty = gazeTarget.y;
  if (gazeOverride) {
    if (Date.now() > gazeOverride.until) gazeOverride = null;
    else { tx = gazeOverride.x; ty = gazeOverride.y; }
  }
  gaze.x += (tx - gaze.x) * 0.1;
  gaze.y += (ty - gaze.y) * 0.1;

  // 睡眠检测
  if (!dragging && !dancing && Date.now() - lastActivity > SLEEP_AFTER_MS) goToSleep();
}

function render() {
  const sq = phys.squash;
  petWrap.style.transform =
    `translateY(${phys.lift.toFixed(2)}px) rotate(${(phys.tilt + phys.spin).toFixed(2)}deg) ` +
    `scale(${(1 + sq).toFixed(4)}, ${(1 - sq).toFixed(4)})`;

  const gx = gaze.x;
  const gy = gaze.y;

  // 头部承担大部分转向；伪透视 + 轻微缩放，模拟「转过来看你」
  headLayer.style.transform =
    `perspective(640px) rotateY(${(gx * 17).toFixed(2)}deg) rotateX(${(-gy * 10).toFixed(2)}deg) ` +
    `translate(${(gx * 6).toFixed(2)}px, ${(gy * 3.5).toFixed(2)}px) scaleX(${(1 + Math.abs(gx) * 0.05).toFixed(3)})`;

  // 上身只跟一点点，拉开与头部的幅度差，才像是脖子在转而不是整块板在晃
  bodyLayer.style.transform = `perspective(640px) rotateY(${(gx * 5.5).toFixed(2)}deg) rotate(${(phys.tilt * 0.16).toFixed(2)}deg)`;
  legsLayer.style.transform = `rotate(${(phys.tilt * 0.07).toFixed(2)}deg)`;
}

function frame() {
  updatePhysics();
  render();
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- 交互 */

async function runAction(name, payload) {
  try {
    return await bridge.action(name, payload);
  } catch (err) {
    return { ok: false, message: `动作执行失败：${err.message}` };
  }
}

async function speakAction(name, payload, holdMs) {
  const res = await runAction(name, payload);
  if (res && res.message) {
    showBubble(res.message, holdMs);
    playMood(res.ok ? res.mood || 'happy' : 'think');
  }
  return res;
}

/** 把情绪翻译成看得见的动作。表情图只有三张，所以靠身体语言补足。 */
function playMood(mood, holdMs = 2400) {
  if (mood === 'happy') {
    holdExpression('happy', holdMs);
    phys.squashV -= 0.06; // 弹一下
    spawnFx('♪', 'note', 66, 80);
  } else if (mood === 'shy') {
    holdExpression('normal', holdMs);
    gazeOverride = { x: -0.6, y: 0.35, until: Date.now() + holdMs };
    spawnFx('·', 'spark', 60, 86);
  } else if (mood === 'think') {
    holdExpression('think', holdMs);
  } else if (mood === 'celebrate') {
    // 连续几次弹跳 + 撒花。刻意不用大幅 spin —— 转体 jQuery 会让她在 0 与 360 之间
    // 「转出去再倒转回来」，看着像抽搐而不像高兴。
    holdExpression('happy', holdMs);
    for (let i = 0; i < 5; i += 1) {
      setTimeout(() => {
        phys.squashV -= 0.07;
        spawnFx('✦', 'spark', 35 + Math.random() * 45, 68 + Math.random() * 20);
      }, i * 130);
    }
  } else if (mood === 'urgent') {
    holdExpression('think', holdMs);
    showBadge('!', 'urgent', holdMs);
  } else if (mood === 'dance') {
    startDance(holdMs === 2400 ? 3 : Math.max(1, Math.round(holdMs / 1300)));
  } else {
    holdExpression('normal', holdMs);
  }
}

function onPointerMove(event) {
  if (dragging) {
    bridge.drag({ x: event.screenX - dragOffset.x, y: event.screenY - dragOffset.y });
    velX = event.screenX - lastMoveX;
    lastMoveX = event.screenX;
    return;
  }

  updateInteractive(hitTest(event.clientX, event.clientY));

  // 自由注视：即便没碰她，也尽量让你的鼠标位置被「看到」
  if (!asleep) {
    const rect = petStack.getBoundingClientRect();
    if (rect.width > 0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height * 0.2;
      gazeTarget.x = clamp((event.clientX - cx) / 260, -1, 1);
      gazeTarget.y = clamp((event.clientY - cy) / 260, -1, 1);
    }
  }

  if (asleep) {
    // 你一动鼠标她就醒了 —— 睡着与否取决于「有没有人理她」，而不是鼠标位置
    wakeUp(false);
  }
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  touchActivity();
  if (!hitTest(event.clientX, event.clientY)) return;

  pressPoint = { x: event.screenX, y: event.screenY };
  dragOrigin = { x: event.screenX, y: event.screenY };
  dragOffset = { x: event.screenX - window.screenX, y: event.screenY - window.screenY };
  lastMoveX = event.screenX;
  dragging = false;
  updateInteractive(true);
}

function onPointerUp(event) {
  if (event.button !== 0) return;

  const wasDragging = dragging;
  dragging = false;
  petWrap.classList.remove('dragging');

  if (wasDragging) {
    touchActivity();
    pressPoint = null;

    // 落地：按最后的速度给一次挤压脉冲，弹簧会把它变成 Q 弹回正
    const impact = Math.min(1, Math.abs(velX) / 26);
    phys.squashV += 0.035 + impact * 0.075;
    phys.spinTarget = clamp(-velX * 2.2, -40, 40);
    velX = 0;

    // 甩得太猛她会晕
    if (impact > 0.72) {
      holdExpression('blink', 1500);
      setTimeout(() => showBubble('哇啊——甩得我头晕…轻点啦。', 3600), 260);
    }
    return;
  }

  if (!pressPoint) return;
  const moved = Math.abs(event.screenX - pressPoint.x) + Math.abs(event.screenY - pressPoint.y);
  pressPoint = null;
  if (moved > DRAG_THRESHOLD) return;

  touchActivity();

  // 单击：她被戳了一下，身体抖一抖
  phys.squashV -= 0.055;
  phys.spinTarget = (Math.random() < 0.5 ? -1 : 1) * 5;
  const line = CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)];
  showBubble(line, 5200);
  holdExpression('happy', 1500);
}

function onPointerLeave() {
  if (!dragging) updateInteractive(false);
}

/* ---------------------------------------------------------------- 启动 */

function bindEvents() {
  window.addEventListener('mousemove', (event) => {
    if (
      pressPoint &&
      !dragging &&
      Math.abs(event.screenX - dragOrigin.x) + Math.abs(event.screenY - dragOrigin.y) > DRAG_THRESHOLD
    ) {
      dragging = true;
      petWrap.classList.add('dragging');
      // 你一拎她，舞就停了 —— 被她拽着走的时候还在自顾自跳舞会很怪
      if (dancing) { idleBusy = false; stopDance(); }
      touchActivity();
    }
    onPointerMove(event);
  });

  window.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('mouseleave', onPointerLeave);

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    touchActivity();
    if (bridge.contextMenu) bridge.contextMenu();
  });

  window.addEventListener('dblclick', () => {
    touchActivity();
    startDance(3);
  });

  window.addEventListener('blur', () => {
    if (!dragging) updateInteractive(false);
  });

  bridge.onSpeak((data) => {
    if (!data || !data.text) return;
    touchActivity();
    const urgent = data.mood === 'urgent';
    showBubble(data.text, 11000, urgent);
    playMood(data.mood || 'normal', 2600);
  });

  // 面板让她表演：抽中奖、吃胖了、答错题目都会传过来
  if (bridge.onPerform) {
    bridge.onPerform((data) => {
      if (!data || !data.mood) return;
      touchActivity();
      playMood(data.mood, data.holdMs || 2400);
    });
  }
}

async function boot() {
  bindEvents();
  preloadDance();
  try {
    await buildHitMap();
  } catch (err) {
    console.warn('命中检测图构建失败，退化为整窗可交互：', err.message);
    hitMap = null;
  }
  scheduleBlink();
  scheduleIdle();
  frame();
}

// 供主进程自测直接触发一段舞（见 MCD_SELFTEST_DANCE）
window.__mcDance = (loops) => startDance(loops || 3);

boot();
