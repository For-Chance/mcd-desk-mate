'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { McpClient } = require('../mcp/client');
const { PetBrain } = require('../mcp/brain');

const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');

// 少数 Windows 显卡驱动在「透明窗口 + 硬件加速」组合下会出现黑底或闪烁，
// 此时设置 MCD_DISABLE_GPU=1 可退回软件渲染。
if (process.env.MCD_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

const WIN_W = 320;
const WIN_H = 600;
const MARGIN = 40;
const BRIEF_INTERVAL_MS = 30 * 60 * 1000;

const DEFAULT_SETTINGS = {
  token: '',
  city: '',
  address: '',
  keyword: '',
  briefInterval: 30,
  autoLaunch: false,
  muted: false
};

let win = null;
let settingsWin = null;
let panelWin = null;
let tray = null;
let client = null;
let brain = null;
let briefTimer = null;
let settings = { ...DEFAULT_SETTINGS };
let lastMood = 'normal';

/* ---------------------------------------------------------------- 配置 */

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadSettings() {
  let stored = {};
  try {
    if (fs.existsSync(configPath())) {
      stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    }
  } catch (err) {
    console.error('[settings] 读取配置失败：', err.message);
  }
  settings = { ...DEFAULT_SETTINGS, ...stored };

  // 环境变量优先，方便 CI / 临时调试
  if (process.env.MCD_MCP_TOKEN) settings.token = process.env.MCD_MCP_TOKEN;

  return settings;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    const dir = path.dirname(configPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] 写入配置失败：', err.message);
  }
  return settings;
}

/* ---------------------------------------------------------------- 窗口 */

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - MARGIN,
    y: workArea.y + workArea.height - WIN_H - MARGIN,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    // 默认鼠标穿透，只有落到麦娘身上才接管
    win.setIgnoreMouseEvents(true, { forward: true });
  });

  win.on('closed', () => {
    win = null;
  });
}

function setInteractive(flag) {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!flag, { forward: true });
}

function speak(text, mood) {
  if (mood) lastMood = mood;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pet:speak', { text, mood: mood || 'normal' });
}

/* ---------------------------------------------------------------- 托盘 */

function trayImage() {
  const iconPath = path.join(ASSETS, 'icon.png');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '麦娘，汇报一下', click: () => runAction('greet') },
    { type: 'separator' },
    { label: '我的优惠券', click: () => runAction('coupons') },
    { label: '一键领取麦麦省券', click: () => runAction('claim') },
    { label: '今日活动', click: () => runAction('campaigns') },
    { label: '我的积分', click: () => runAction('points') },
    { label: '最近订单', click: () => runAction('orders') },
    { label: '附近门店', click: () => runAction('stores') },
    { type: 'separator' },
    { label: '🎰 扭蛋机抽奖', click: () => openPanel('gacha') },
    { label: '🎫 我的节气收藏册', click: () => openPanel('collection') },
    { label: '🍔 投喂麦娘', click: () => openPanel('feed') },
    { label: '🎯 猜热量', click: () => openPanel('quiz') },
    { type: 'separator' },
    { label: '设置 MCP Token…', click: () => openSettings() },
    {
      label: '打开配置文件',
      click: () => shell.openPath(configPath())
    },
    {
      label: '暂停播报',
      type: 'checkbox',
      checked: settings.muted,
      click: (item) => {
        saveSettings({ muted: item.checked });
        scheduleBriefing();
      }
    },
    { type: 'separator' },
    {
      label: '显示麦娘',
      type: 'checkbox',
      checked: true,
      click: (item) => {
        if (!win) return;
        if (item.checked) win.showInactive();
        else win.hide();
      }
    },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: settings.autoLaunch,
      click: (item) => {
        saveSettings({ autoLaunch: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('麦娘桌面 McDesk');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/** 在麦娘身上点右键时弹出的菜单（全能入口）。 */
function buildPetMenu() {
  return Menu.buildFromTemplate([
    { label: '麦娘，汇报一下', click: () => runAction('greet') },
    { type: 'separator' },
    { label: '🎰 扭蛋机抽奖', click: () => openPanel('gacha') },
    { label: '🎫 我的节气收藏册', click: () => openPanel('collection') },
    { label: '🍔 投喂麦娘', click: () => openPanel('feed') },
    { label: '🎯 猜热量', click: () => openPanel('quiz') },
    { type: 'separator' },
    { label: '我的优惠券', click: () => runAction('coupons') },
    { label: '一键领取麦麦省券', click: () => runAction('claim') },
    { label: '今日活动', click: () => runAction('campaigns') },
    { label: '我的积分', click: () => runAction('points') },
    { label: '最近订单', click: () => runAction('orders') },
    { label: '附近门店', click: () => runAction('stores') },
    { type: 'separator' },
    { label: '设置 MCP Token…', click: () => openSettings() },
    { label: '暂时藏起来', click: () => win && win.hide() },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
}

/* ---------------------------------------------------------------- 设置窗 */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 470,
    height: 640,
    title: '麦娘桌面 · 设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(ROOT, 'src', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ---------------------------------------------------------------- 玩法面板 */

/** 独立的玩法窗口：扭蛋机 / 节气收藏册 / 投喂菜单 / 猜热量。 */
function openPanel(mode = 'gacha') {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('panel:mode', mode);
    panelWin.focus();
    return { ok: true, reused: true };
  }

  panelWin = new BrowserWindow({
    width: 540,
    height: 720,
    title: '麦娘 · 玩法面板',
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  panelWin.setMenuBarVisibility(false);
  // mode 走 query，避免 loadFile 与 IPC 之间的时序竞争
  panelWin.loadFile(path.join(ROOT, 'src', 'renderer', 'panel.html'), { query: { mode } });
  panelWin.on('closed', () => { panelWin = null; });

  return { ok: true };
}

/* ---------------------------------------------------------------- 业务 */

async function runAction(name, payload = {}) {
  if (!brain) return { ok: false, message: '服务尚未就绪。' };

  if (!client.configured && name !== 'status') {
    speak('还没配置 MCP Token 呢，点托盘里的「设置 MCP Token」就能开始啦～', 'think');
    openSettings();
    return { ok: false, message: '未配置 Token' };
  }

  try {
    switch (name) {
      case 'greet': {
        await brain.refresh();
        return { ok: true, message: brain.buildBriefing(), mood: brain.briefingMood() };
      }
      case 'coupons':
        return brain.couponReport();
      case 'claim': {
        const res = await brain.claimAllCoupons();
        if (res.refresh) await brain.refresh();
        return { ...res, mood: res.ok ? 'happy' : 'normal' };
      }
      case 'points':
        return brain.pointsReport();
      case 'campaigns':
        return brain.campaignReport();
      case 'orders':
        return brain.orderReport();
      case 'stores':
        return brain.storeReport({ city: settings.city, keyword: settings.keyword || settings.address });
      case 'nutrition':
        return brain.nutritionLookup(payload.keyword);
      case 'status':
        return { ok: true, ...brain.status };

      // --- 趣味性玩法 ---
      case 'gacha':
        return brain.lotteryInfo();
      case 'draw': {
        // confirm 必须是严格 true；brain 内部另有冷却与积分闸门兜底
        const res = await brain.drawLottery({ confirm: payload.confirm === true });
        if (res.ok) {
          // 抽奖必然改变积分余额，后台静默刷新快照，不阻塞本次返回
          brain.refresh().catch(() => {});
        }
        return res;
      }
      case 'collection':
        return brain.prizeCollection();
      case 'menu':
        return brain.menuOptions();
      case 'feed':
        return brain.feed(payload.keyword);
      case 'quiz':
        return brain.calorieQuiz();

      default:
        return { ok: false, message: `还不认识这个指令：${name}` };
    }
  } catch (err) {
    console.error('[action] 执行失败：', err);
    return { ok: false, message: `出错了：${err.message}` };
  }
}

function scheduleBriefing() {
  if (briefTimer) {
    clearInterval(briefTimer);
    briefTimer = null;
  }
  if (settings.muted || !client.configured) return;

  const minutes = Math.max(5, Number(settings.briefInterval) || 30);
  briefTimer = setInterval(async () => {
    const res = await runAction('greet');
    if (res.ok) speak(res.message, res.mood || 'normal');
  }, minutes * 60 * 1000);
}

function createClient() {
  client = new McpClient({ token: settings.token });
  brain = new PetBrain(client, {
    onEvent: (evt) => {
      if (evt.type === 'tool-error') {
        console.warn(`[mcp] ${evt.tool} 调用失败：${evt.message}`);
      }
    }
  });
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.on('pet:set-interactive', (_e, flag) => setInteractive(Boolean(flag)));

  ipcMain.on('pet:drag', (_e, pos) => {
    if (!win || win.isDestroyed()) return;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      win.setPosition(Math.round(pos.x), Math.round(pos.y));
    }
  });

  ipcMain.handle('pet:action', (_e, { name, payload }) => runAction(name, payload));

  ipcMain.on('pet:context-menu', () => {
    if (!win || win.isDestroyed()) return;
    buildPetMenu().popup({ window: win });
  });

  ipcMain.handle('pet:get-settings', () => ({
    ...settings,
    token: settings.token ? `${settings.token.slice(0, 6)}••••${settings.token.slice(-4)}` : '',
    hasToken: Boolean(settings.token),
    configPath: configPath()
  }));

  ipcMain.handle('pet:save-settings', (_e, patch) => {
    const clean = { ...patch };
    // 掩码值表示「用户没有改动 Token」，不覆盖原值
    if (typeof clean.token === 'string' && clean.token.includes('••••')) delete clean.token;
    saveSettings(clean);

    if (clean.token !== undefined && clean.token !== settings.token) {
      client.setToken(settings.token);
    }
    if (clean.autoLaunch !== undefined) {
      app.setLoginItemSettings({ openAtLogin: Boolean(clean.autoLaunch) });
    }

    scheduleBriefing();
    refreshTray();

    return { ok: true, configPath: configPath() };
  });

  ipcMain.handle('pet:test-connection', async (_e, token) => {
    const probe = new McpClient({ token: token || settings.token, timeout: 15000 });
    if (!probe.configured) return { ok: false, message: 'Token 不能为空' };
    try {
      const tools = await probe.listTools();
      return { ok: true, message: `连接成功，可用工具 ${tools.length} 个` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.on('pet:close-settings', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });

  // --- 玩法面板 ---

  ipcMain.handle('pet:open-panel', (_e, { mode } = {}) => openPanel(mode || 'gacha'));

  ipcMain.on('pet:perform', (_e, payload) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('pet:perform', payload || {});
  });

  ipcMain.on('pet:say', (_e, payload) => {
    const { text, mood } = payload || {};
    if (text) speak(text, mood);
  });

  ipcMain.on('pet:close-panel', () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  });

  ipcMain.on('pet:quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.on('pet:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

/* ---------------------------------------------------------------- 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.showInactive();
  });

  app.whenReady().then(() => {
    loadSettings();
    createClient();
    registerIpc();
    createWindow();
    createTray();

    app.setLoginItemSettings({ openAtLogin: Boolean(settings.autoLaunch) });
    scheduleBriefing();

    // 启动后延迟打招呼，等渲染层就绪
    setTimeout(async () => {
      const res = await runAction('greet');
      if (res.ok && res.message) speak(res.message, res.mood || 'normal');
      else if (!client.configured) {
        speak('你好呀，我是麦娘！先去 open.mcd.cn 申请 MCP Token，我就能帮你管券管积分啦～', 'normal');
      }
    }, 2600);

    // 冒烟自测：MCD_SELFTEST=<毫秒> 时截图并自行退出，便于本地验证与 CI
    if (process.env.MCD_SELFTEST) {
      const ms = Number(process.env.MCD_SELFTEST) || 8000;
      setTimeout(async () => {
        const dir = path.join(ROOT, '.selftest');
        fs.mkdirSync(dir, { recursive: true });

        const shoot = async (target, file) => {
          try {
            if (!target || target.isDestroyed()) return;
            const image = await target.capturePage();
            const out = path.join(dir, file);
            fs.writeFileSync(out, image.toPNG());
            console.log(`[selftest] 截图已保存：${out}`);
          } catch (err) {
            console.error(`[selftest] 截图 ${file} 失败：`, err.message);
          }
        };

        // MCD_SELFTEST_DANCE=1 触发一段舞，按节拍连拍几帧，
        // 用于验证「换姿态帧」整条链路（素材坐标系统一 / 换帧 / 力度叠加）
        if (process.env.MCD_SELFTEST_DANCE) {
          await win.webContents.executeJavaScript(
            'window.__mcDance && window.__mcDance(1)'
          );
          await shoot(win, 'dance-0.png');
          for (let i = 1; i <= 7; i += 1) {
            await new Promise((r) => setTimeout(r, 430));
            await shoot(win, `dance-${i}.png`);
          }
        }

        await shoot(win, 'shot.png');

        // MCD_SELFTEST_SETTINGS=1 顺便截一张设置窗
        if (process.env.MCD_SELFTEST_SETTINGS === '1') {
          openSettings();
          await new Promise((r) => setTimeout(r, 1800));
          await shoot(settingsWin, 'settings.png');
        }

        // MCD_SELFTEST_PANEL=gacha|collection|feed|quiz 截一张玩法面板
        if (process.env.MCD_SELFTEST_PANEL) {
          openPanel(process.env.MCD_SELFTEST_PANEL);
          await new Promise((r) => setTimeout(r, Number(process.env.MCD_SELFTEST_PANEL_WAIT) || 9000));
          await shoot(panelWin, `panel-${process.env.MCD_SELFTEST_PANEL}.png`);
        }

        console.log('[selftest] 主进程运行正常，自动退出');
        app.isQuitting = true;
        app.quit();
      }, ms);
    }
  });

  app.on('window-all-closed', () => {
    // 桌宠常驻托盘，关闭设置窗不应退出应用
  });

  app.on('activate', () => {
    if (!win) createWindow();
  });
}
