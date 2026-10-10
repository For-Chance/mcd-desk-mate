'use strict';

const bridge = window.mcd;

const el = (id) => document.getElementById(id);
const tokenInput = el('token');
const cityInput = el('city');
const addressInput = el('address');
const intervalInput = el('interval');
const statusEl = el('status');
const saveStatusEl = el('save-status');
const pathEl = el('path');

function setStatus(node, text, kind = '') {
  node.textContent = text;
  node.className = `status ${kind}`;
}

/** 判断输入框里是不是「未改动的掩码值」。 */
function isMasked(value) {
  return typeof value === 'string' && value.includes('••••');
}

async function load() {
  const s = await bridge.getSettings();
  tokenInput.value = s.token || '';
  cityInput.value = s.city || '';
  addressInput.value = s.keyword || s.address || '';
  intervalInput.value = s.briefInterval || 30;
  tokenInput.placeholder = s.hasToken ? '已保存，留空则不修改' : '粘贴你的 MCP Token';
  if (s.configPath) pathEl.textContent = `配置文件：${s.configPath}`;
}

el('test').addEventListener('click', async () => {
  const raw = tokenInput.value.trim();
  const token = isMasked(raw) ? '' : raw;
  setStatus(statusEl, '正在连接麦当劳 MCP…', 'busy');

  const res = await bridge.testConnection(token);
  setStatus(statusEl, res.message, res.ok ? 'ok' : 'err');
});

el('save').addEventListener('click', async () => {
  const rawToken = tokenInput.value.trim();
  const patch = {
    city: cityInput.value.trim(),
    address: addressInput.value.trim(),
    briefInterval: Number(intervalInput.value) || 30
  };
  if (!isMasked(rawToken)) patch.token = rawToken;

  setStatus(saveStatusEl, '保存中…', 'busy');
  const res = await bridge.saveSettings(patch);
  setStatus(saveStatusEl, res.ok ? '已保存' : '保存失败', res.ok ? 'ok' : 'err');

  if (res.ok) setTimeout(() => setStatus(saveStatusEl, ''), 2200);
});

el('cancel').addEventListener('click', () => bridge.closeSettings());

el('link-open').addEventListener('click', (event) => {
  event.preventDefault();
  bridge.openExternal('https://open.mcd.cn/mcp');
});

load();
