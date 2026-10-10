'use strict';

/**
 * 麦当劳 MCP Server 的轻量客户端。
 *
 * 传输协议：Streamable HTTP（单一端点，POST JSON-RPC 报文）
 * 端点：https://mcp.mcd.cn
 * 认证：Authorization: Bearer <MCP_TOKEN>
 *
 * 服务端可能以 `application/json` 或 `text/event-stream` 返回，
 * 因此响应解析需要同时兼容两种形态。
 */

const DEFAULT_URL = 'https://mcp.mcd.cn';
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_NAME = 'mcd-desk-mate';
const CLIENT_VERSION = '0.1.0';

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

class McpClient {
  constructor({ url = DEFAULT_URL, token = '', timeout = 20000 } = {}) {
    this.url = url;
    this.token = token;
    this.timeout = timeout;
    this.sessionId = null;
    this.initialized = false;
    this._nextId = 1;
  }

  get configured() {
    return Boolean(this.token && this.token.trim());
  }

  setToken(token) {
    this.token = token || '';
    this.sessionId = null;
    this.initialized = false;
  }

  /** 发送一次 JSON-RPC 调用。notification 为 true 时不等待响应体。 */
  async _rpc(method, params, { notification = false } = {}) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    if (!notification) payload.id = this._nextId++;

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.token}`
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new McpError(`请求超时（${this.timeout}ms）`, 'TIMEOUT');
      }
      throw new McpError(`无法连接麦当劳 MCP 服务：${err.message}`, 'NETWORK');
    }
    clearTimeout(timer);

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) throw new McpError('MCP Token 无效、已过期或未提供（401）', 401);
    if (res.status === 429) throw new McpError('触发限流，每分钟最多 600 次请求（429）', 429);
    if (!res.ok) throw new McpError(`MCP 服务返回 HTTP ${res.status}`, res.status);

    if (notification) return null;

    return this._parse(await res.text());
  }

  /** 兼容纯 JSON 与 SSE（data: 行）两种响应体。 */
  _parse(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }

    let last = null;
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === '[DONE]') continue;
      try {
        last = JSON.parse(chunk);
      } catch {
        /* 忽略无法解析的分片 */
      }
    }
    return last;
  }

  async initialize() {
    if (!this.configured) throw new McpError('尚未配置 MCP Token', 'NO_TOKEN');
    if (this.initialized) return;

    const res = await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
    });

    if (res && res.error) {
      throw new McpError(res.error.message || '初始化失败', res.error.code);
    }

    await this._rpc('notifications/initialized', undefined, { notification: true });
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const res = await this._rpc('tools/list', {});
    if (res && res.error) throw new McpError(res.error.message, res.error.code);
    return (res && res.result && res.result.tools) || [];
  }

  /** 调用一个 MCP Tool，并把 MCP 的 content 数组还原成业务数据。 */
  async callTool(name, args = {}) {
    await this.initialize();
    const res = await this._rpc('tools/call', { name, arguments: args });

    if (!res) throw new McpError(`工具 ${name} 未返回结果`, 'EMPTY');
    if (res.error) throw new McpError(res.error.message || `工具 ${name} 调用失败`, res.error.code);

    const result = res.result || {};
    if (result.isError) {
      const detail = this._extractText(result);
      throw new McpError(detail || `工具 ${name} 执行出错`, 'TOOL_ERROR');
    }
    return this._unwrap(result);
  }

  _extractText(result) {
    const parts = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text);
    return parts.join('\n');
  }

  _unwrap(result) {
    const parts = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text);
    if (parts.length === 0) return result.structuredContent || result;
    if (parts.length === 1) return parseMaybeJson(parts[0]);
    return parts.map(parseMaybeJson);
  }
}

function parseMaybeJson(text) {
  if (typeof text !== 'string') return text;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

module.exports = { McpClient, McpError, DEFAULT_URL };
