/**
 * TIKTOK QR CODE HEADLESS WORKER (CHUẨN NAPXU.VN)
 * -------------------------------------------------------------
 * Chạy trên máy tính hoặc VPS có cài đặt Google Chrome hoặc Microsoft Edge.
 * Cơ chế:
 * 1. Mở TikTok ngầm bằng Trình duyệt thật (Chromium/Edge) có hỗ trợ JS MSSDK.
 * 2. Lấy ảnh QR trực tiếp từ <canvas> của TikTok.
 * 3. Khi người dùng quét app và bấm "Xác nhận" trên điện thoại:
 *    Trình duyệt tự động nhận diện đăng nhập, bắt lấy sessionid và Cookie thật!
 * 4. Trả kết quả về cho Website PHP lưu vào database.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 5050;

// Tìm đường dẫn Chrome hoặc Edge trên hệ thống
function getBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
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
    this.createdAt = Date.now();
    this.port = 9300 + Math.floor(Math.random() * 500);
    this.userDir = path.join(os.tmpdir(), `tt_qr_profile_${this.id}`);
    this.browserProc = null;
    this.ws = null;
  }

  async start() {
    const browserPath = getBrowserExecutable();
    if (!browserPath) {
      this.status = 'error';
      this.error = 'Không tìm thấy trình duyệt Edge hoặc Chrome!';
      return;
    }

    this.browserProc = spawn(browserPath, [
      '--headless=new',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDir}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'https://www.tiktok.com/login/qrcode'
    ]);

    // Đợi trình duyệt khởi động và lấy WebSocket URL
    let retries = 0;
    let wsUrl = null;
    while (retries < 15 && !wsUrl) {
      await new Promise(r => setTimeout(r, 600));
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json`);
        const tabs = await res.json();
        const ttTab = tabs.find(t => t.url && t.url.includes('tiktok.com'));
        if (ttTab && ttTab.webSocketDebuggerUrl) {
          wsUrl = ttTab.webSocketDebuggerUrl;
        }
      } catch (e) {
        // Tiếp tục đợi
      }
      retries++;
    }

    if (!wsUrl) {
      this.status = 'error';
      this.error = 'Không thể kết nối DevTools của trình duyệt!';
      this.destroy();
      return;
    }

    // Kết nối WebSocket DevTools
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      // Bật Network domain để lấy Cookies
      this.ws.send(JSON.stringify({ id: 10, method: 'Network.enable' }));
      this.pollForQR();
      this.pollForCookies();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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
  }

  pollForQR() {
    if (this.status === 'confirmed' || this.status === 'closed') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
      const res = await fetch('https://www.tiktok.com/passport/web/account/info/', {
        headers: {
          'Cookie': this.cookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Referer': 'https://www.tiktok.com/'
        }
      });
      const data = await res.json();
      if (data?.data?.username) {
        this.account = {
          username: data.data.username,
          nickname: data.data.screen_name || data.data.username,
          avatar: data.data.avatar_url || ''
        };
      }
    } catch (e) {}
    // Sau khi xác nhận thành công 5 giây thì đóng trình duyệt để giải phóng RAM
    setTimeout(() => this.destroy(), 5000);
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
    // Dọn dẹp thư mục tạm
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

    // Đợi tối đa 6 giây để có ảnh QR
    let wait = 0;
    while (wait < 12 && !session.qrImage && session.status !== 'error') {
      await new Promise(r => setTimeout(r, 500));
      wait++;
    }

    if (session.qrImage) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'success',
        qr_id: id,
        qr_image: session.qrImage,
        time_remaining: 180,
        msg: 'Đã tạo mã QR TikTok qua Trình duyệt thành công!'
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
          username: 'user_' + session.sessionId.slice(0, 8),
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
  console.log(`[TikTok QR Worker] Server đang chạy tại http://localhost:${PORT}`);
  console.log(`Browser: ${getBrowserExecutable()}`);
  console.log(`=======================================================`);
});
