/**
 * TIKTOK QR CODE HEADLESS WORKER (CHUẨN NAPXU.VN)
 * -------------------------------------------------------------
 * Chạy trên Render.com, VPS hoặc máy tính cá nhân.
 * Hỗ trợ Chromium/Edge Headless và tự động fallback API TikTok.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

// Bắt lỗi toàn cục để server KHÔNG BAO GIỜ bị crash
process.on('uncaughtException', (err) => {
  console.error('[Worker uncaughtException]:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Worker unhandledRejection]:', reason);
});

let WebSocketClient = globalThis.WebSocket;
try {
  if (!WebSocketClient) {
    WebSocketClient = require('ws');
  }
} catch (e) {}

const PORT = process.env.PORT || 5050;

function getBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const possiblePaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const sessions = new Map();

class QRSession {
  constructor(id) {
    this.id = id;
    this.status = 'initializing';
    this.qrImage = null;
    this.cookies = null;
    this.sessionId = null;
    this.account = null;
    this.apiToken = null;
    this.createdAt = Date.now();
    this.port = 9300 + Math.floor(Math.random() * 500);
    this.userDir = path.join(os.tmpdir(), `tt_qr_profile_${this.id}`);
    this.browserProc = null;
    this.ws = null;
  }

  async start() {
    const browserPath = getBrowserExecutable();
    if (!browserPath) {
      console.log(`[QRSession ${this.id}] Không tìm thấy trình duyệt, dùng API fallback trực tiếp.`);
      await this.fallbackGetQR();
      return;
    }

    try {
      this.browserProc = spawn(browserPath, [
        '--headless=new',
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.userDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        'https://www.tiktok.com/login/qrcode'
      ]);

      let retries = 0;
      let wsUrl = null;
      while (retries < 10 && !wsUrl) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const res = await fetch(`http://127.0.0.1:${this.port}/json`);
          const tabs = await res.json();
          const ttTab = tabs.find(t => t.url && t.url.includes('tiktok.com'));
          if (ttTab && ttTab.webSocketDebuggerUrl) {
            wsUrl = ttTab.webSocketDebuggerUrl;
          }
        } catch (e) {}
        retries++;
      }

      if (wsUrl && WebSocketClient) {
        this.ws = new WebSocketClient(wsUrl);
        this.ws.onopen = () => {
          try {
            this.ws.send(JSON.stringify({ id: 10, method: 'Network.enable' }));
            this.pollForQR();
            this.pollForCookies();
          } catch (e) {}
        };

        this.ws.onmessage = (event) => {
          try {
            const dataStr = typeof event.data === 'string' ? event.data : event.data.toString();
            const msg = JSON.parse(dataStr);
            if (msg.id === 20 && msg.result?.result?.value) {
              const val = msg.result.result.value;
              if (val.startsWith('data:image')) {
                this.qrImage = val;
                this.status = 'waiting_scan';
              }
            }
            if (msg.id === 30 && msg.result?.cookies) {
              const cookiesList = msg.result.cookies;
              const sessionCookie = cookiesList.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
              if (sessionCookie && sessionCookie.value) {
                this.sessionId = sessionCookie.value;
                this.cookies = cookiesList.map(c => `${c.name}=${c.value}`).join('; ');
                this.status = 'confirmed';
                this.fetchProfileInfo();
              }
            }
          } catch (e) {}
        };
      } else {
        console.log(`[QRSession ${this.id}] DevTools chưa sẵn sàng, gọi API fallback.`);
        await this.fallbackGetQR();
      }
    } catch (e) {
      console.log(`[QRSession ${this.id}] Trình duyệt lỗi: ${e.message}, gọi API fallback.`);
      await this.fallbackGetQR();
    }
  }

  async fallbackGetQR() {
    try {
      const res = await fetch('https://www.tiktok.com/passport/web/get_qrcode/?next=https%3A%2F%2Fwww.tiktok.com&aid=1459', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Referer': 'https://www.tiktok.com/login/qrcode',
          'Accept': 'application/json, text/javascript'
        }
      });
      const data = await res.json();
      if (data?.data?.qrcode) {
        this.qrImage = 'data:image/png;base64,' + data.data.qrcode;
        this.apiToken = data.data.token;
        this.status = 'waiting_scan';
        this.pollApiCheck();
      }
    } catch (e) {
      this.status = 'error';
      this.error = 'Không thể lấy mã QR từ TikTok lúc này!';
    }
  }

  async pollApiCheck() {
    if (this.status === 'confirmed' || this.status === 'closed' || !this.apiToken) return;
    try {
      const res = await fetch(`https://www.tiktok.com/passport/web/check_qrconnect/?next=https%3A%2F%2Fwww.tiktok.com&token=${encodeURIComponent(this.apiToken)}&aid=1459`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Referer': 'https://www.tiktok.com/login/qrcode'
        }
      });
      const setCookie = res.headers.get('set-cookie') || '';
      const m = setCookie.match(/sessionid=([^;]+)/);
      if (m && m[1]) {
        this.sessionId = m[1];
        this.cookies = setCookie;
        this.status = 'confirmed';
        this.fetchProfileInfo();
        return;
      }
      const data = await res.json();
      if (data?.data?.status === 'expired') {
        this.status = 'expired';
        return;
      }
    } catch (e) {}
    setTimeout(() => this.pollApiCheck(), 2500);
  }

  pollForQR() {
    if (this.status === 'confirmed' || this.status === 'closed') return;
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (WebSocketClient ? WebSocketClient.OPEN : 1))) {
      this.ws.send(JSON.stringify({
        id: 20,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) return canvas.toDataURL();
            const img = document.querySelector('img[src*="qrcode"], div[data-e2e="qr-code"] img');
            if (img && img.src) return img.src;
            return null;
          })()`,
          returnByValue: true
        }
      }));
    }
    if (!this.qrImage) {
      setTimeout(() => this.pollForQR(), 1000);
    }
  }

  pollForCookies() {
    if (this.status === 'confirmed' || this.status === 'closed') return;
    if (Date.now() - this.createdAt > 180000) {
      this.status = 'expired';
      this.destroy();
      return;
    }
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (WebSocketClient ? WebSocketClient.OPEN : 1))) {
      this.ws.send(JSON.stringify({
        id: 30,
        method: 'Network.getCookies',
        params: { urls: ['https://www.tiktok.com', 'https://tiktok.com', 'https://passport.tiktok.com', 'https://www-va.tiktok.com'] }
      }));
    }
    setTimeout(() => this.pollForCookies(), 2000);
  }

  async fetchProfileInfo() {
    try {
      const res = await fetch('https://www.tiktok.com/passport/web/account/info/?aid=1459', {
        headers: {
          'Cookie': this.cookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Referer': 'https://www.tiktok.com/'
        }
      });
      const data = await res.json();
      const uName = data?.data?.username || data?.data?.screen_name || data?.data?.name;
      if (uName) {
        this.account = {
          username: uName.replace(/^@/, ''),
          nickname: data?.data?.screen_name || uName,
          avatar: data?.data?.avatar_url || ''
        };
      }
    } catch (e) {}

    if (!this.account) {
      try {
        const res2 = await fetch('https://www.tiktok.com/', {
          headers: {
            'Cookie': this.cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
          }
        });
        const html = await res2.text();
        const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
        if (m) {
          const d = JSON.parse(m[1]);
          const u = d?.['__DEFAULT_SCOPE__']?.['webapp.app-context']?.user;
          if (u?.uniqueId) {
            this.account = {
              username: u.uniqueId,
              nickname: u.nickName || u.uniqueId,
              avatar: u.avatarLarger || u.avatarThumb || ''
            };
          }
        }
      } catch (e) {}
    }
    setTimeout(() => this.destroy(), 8000);
  }

  destroy() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    if (this.browserProc) {
      try { this.browserProc.kill(); } catch (e) {}
      this.browserProc = null;
    }
    setTimeout(() => {
      try { fs.rmSync(this.userDir, { recursive: true, force: true }); } catch (e) {}
    }, 2000);
  }
}

// Khởi tạo HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 1. API TẠO MÃ QR: /api/qr/create
  if (pathname === '/api/qr/create') {
    const id = 'qr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const session = new QRSession(id);
    sessions.set(id, session);
    session.start();

    // Đợi tối đa 5 giây để có ảnh QR
    let wait = 0;
    while (wait < 10 && !session.qrImage && session.status !== 'error') {
      await new Promise(r => setTimeout(r, 500));
      wait++;
    }

    // Nếu trình duyệt chưa kịp có, gọi fallback trực tiếp
    if (!session.qrImage) {
      await session.fallbackGetQR();
    }

    if (session.qrImage) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'success',
        qr_id: id,
        qr_image: session.qrImage,
        time_remaining: 180,
        msg: 'Đã tạo mã QR TikTok thành công!'
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'error',
        msg: session.error || 'Trình duyệt chưa kịp sinh mã QR. Vui lòng thử lại!'
      }));
    }
    return;
  }

  // 2. API CHECK TRẠNG THÁI: /api/qr/status?qr_id=...
  if (pathname === '/api/qr/status') {
    const id = parsedUrl.query.qr_id;
    const session = sessions.get(id);

    if (!session) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'expired', msg: 'Phiên quét không tồn tại hoặc đã hết hạn.' }));
      return;
    }

    if (session.status === 'confirmed') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'confirmed',
        session_id: session.sessionId,
        cookies: session.cookies,
        account: session.account || {
          username: 'user_' + (session.sessionId ? session.sessionId.slice(0, 8) : 'tiktok'),
          nickname: 'TikTok User',
          avatar: ''
        },
        msg: 'Đăng nhập TikTok thành công!'
      }));
      return;
    }

    if (session.status === 'expired') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'expired', msg: 'Mã QR đã hết hạn.' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'waiting',
      msg: 'Đang chờ người dùng quét và bấm xác nhận trên điện thoại...'
    }));
    return;
  }

  // Mặc định
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    service: 'TikTok QR Headless Worker',
    status: 'running',
    port: PORT,
    endpoints: ['/api/qr/create', '/api/qr/status?qr_id=...']
  }));
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`[TikTok QR Worker] Server đang chạy tại cổng ${PORT}`);
  console.log(`Browser: ${getBrowserExecutable()}`);
  console.log(`=======================================================`);
});
