'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程与主进程之间的唯一通道。
 * 只暴露经过白名单的动作名，渲染层拿不到任意 IPC 能力。
 */

const ALLOWED_ACTIONS = new Set([
  'greet',
  'coupons',
  'claim',
  'campaigns',
  'points',
  'orders',
  'stores',
  'nutrition',
  'status',
  // 趣味性玩法
  'gacha',      // 查看抽奖活动（只读）
  'draw',       // 真的抽一次，必须带 confirm
  'collection', // 奖品墙 + 节气收藏册
  'menu',       // 投喂候选菜单
  'feed',       // 投喂一口
  'quiz'        // 猜热量出题
]);

contextBridge.exposeInMainWorld('mcd', {
  /** 切换窗口是否接管鼠标（落到角色身上才接管，其余穿透到桌面） */
  setInteractive: (flag) => ipcRenderer.send('pet:set-interactive', Boolean(flag)),

  /** 弹出原生右键菜单（菜单需要显示在窗口外，因此交给主进程） */
  contextMenu: () => ipcRenderer.send('pet:context-menu'),

  /** 拖拽时同步窗口位置 */
  drag: (pos) => ipcRenderer.send('pet:drag', pos),

  /** 触发一个业务动作 */
  action: (name, payload = {}) => {
    if (!ALLOWED_ACTIONS.has(name)) {
      return Promise.resolve({ ok: false, message: `不允许的动作：${name}` });
    }
    return ipcRenderer.invoke('pet:action', { name, payload });
  },

  getSettings: () => ipcRenderer.invoke('pet:get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('pet:save-settings', patch),
  testConnection: (token) => ipcRenderer.invoke('pet:test-connection', token),

  closeSettings: () => ipcRenderer.send('pet:close-settings'),
  quit: () => ipcRenderer.send('pet:quit'),
  openExternal: (url) => ipcRenderer.send('pet:open-external', url),

  /** 请求打开玩法面板（gacha / collection / feed / quiz） */
  openPanel: (mode) => ipcRenderer.invoke('pet:open-panel', { mode }),

  /** 面板专用：让桌宠本体表演一个情绪（例如抽中时的撒欢） */
  perform: (mood, holdMs) => ipcRenderer.send('pet:perform', { mood, holdMs }),

  /** 面板专用：让桌宠本体开口说话 */
  say: (text, mood) => ipcRenderer.send('pet:say', { text, mood }),

  /** 玩法面板关闭自身 */
  closePanel: () => ipcRenderer.send('pet:close-panel'),

  /** 主进程主动让麦娘说话 */
  onSpeak: (handler) => {
    ipcRenderer.on('pet:speak', (_e, data) => handler(data));
  },

  /** 面板请求桌宠本体做一个情绪表演 */
  onPerform: (handler) => {
    ipcRenderer.on('pet:perform', (_e, data) => handler(data));
  },

  /** 已打开的面板接收模式切换 */
  onPanelMode: (handler) => {
    ipcRenderer.on('panel:mode', (_e, mode) => handler(mode));
  }
});
