const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const P = require('./lib/processor');
const N = require('./lib/naming');
const { CpuLimiter } = require('./lib/cpu');

const PORT = Number(process.env.PORT) || 5577;
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
  inputDir: '', outputDir: '', musicDir: '',
  skipExisting: true,
  naming: {
    prefix: '', addIndex: false, indexStart: 1, indexPad: 3, keepName: true,
    addMusicIndex: false, musicLabel: 'nhac', musicPad: 2, suffix: '', separator: '_',
    order: ['prefix', 'index', 'name', 'music', 'suffix'],
  },
  perf: { concurrency: 2, lowPriority: true, limitThreads: true, maxThreads: 0, power: 100 },
  color: { enabled: true, brightness: 0.05, contrast: 1.1, saturation: 1.2 },
  frame: { enabled: true, mode: 'color', color: '#ffffff', thicknessPct: 3, opacity: 0.6, image: '' },
  speed: { enabled: true, value: 1.1 },
  flip: { enabled: true, horizontal: true, vertical: false },
  rotate: { enabled: true, min: 1, max: 2, randomDirection: true },
  scale: { enabled: true, percent: 105, autoFill: true },
  mute: { enabled: true },
  music: { enabled: true, volume: 1, fadeOut: 1.5 },
  encode: { encoder: 'auto', preset: 'veryfast', crf: 20, limitBitrate: true, maxBitrate: 8 },
};

function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved.concurrency && !saved.perf) saved.perf = { concurrency: saved.concurrency };
    delete saved.concurrency;
    if (saved.suffix !== undefined && !saved.naming) saved.naming = { suffix: saved.suffix };
    delete saved.suffix;
    return merge(DEFAULTS, saved);
  } catch { return merge(DEFAULTS, {}); }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

const ENC_LABEL = { cpu: 'CPU', nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD' };

// ---------- batch job ----------
let job = null; // { running, stopping, items: [...], procs: Set }

// `retryErrors`: reuse the previous list and only re-run the items that failed.
async function startJob(cfg, { retryErrors = false } = {}) {
  if (job && job.running) throw new Error('Đang chạy, hãy dừng trước');
  const prev = job;
  if (retryErrors) {
    if (!prev || !prev.items.some((it) => it.status === 'error')) throw new Error('Không có file lỗi nào để chạy lại');
    if (path.resolve(prev.inputDir) !== path.resolve(cfg.inputDir || '')) throw new Error('Thư mục video gốc đã đổi, hãy bấm Bắt đầu xử lý');
  }
  if (!cfg.inputDir || !fs.existsSync(cfg.inputDir)) throw new Error('Thư mục video gốc không tồn tại');
  if (!cfg.outputDir) throw new Error('Chưa chọn thư mục xuất');
  if (path.resolve(cfg.inputDir) === path.resolve(cfg.outputDir)) throw new Error('Thư mục xuất phải khác thư mục gốc');
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  const videos = P.listFiles(cfg.inputDir, P.VIDEO_EXT);
  if (!videos.length) throw new Error('Không có video nào trong thư mục gốc');
  const musicFiles = cfg.music.enabled ? await P.listMusic(cfg.musicDir) : [];
  if (cfg.music.enabled && !musicFiles.length) throw new Error('Thư mục nhạc không có file nào có tiếng (mp3, m4a, wav, mp4…)');
  const picker = new P.MusicPicker(musicFiles);
  // No music → no music number in the name, so skip-existing must not look for one either.
  const naming = cfg.music.enabled ? cfg.naming : { ...cfg.naming, addMusicIndex: false };

  const fresh = (it) => ({ ...it, status: 'pending', progress: 0, msg: '', outName: '' });
  job = {
    running: true, stopping: false, procs: new Set(), startedAt: Date.now(), inputDir: cfg.inputDir,
    items: retryErrors
      ? prev.items.map((it) => (it.status === 'error' ? fresh(it) : { ...it }))
      : videos.map((v, index) => fresh({ name: path.basename(v), input: v, base: path.basename(v, path.extname(v)), index })),
  };
  const existing = fs.readdirSync(cfg.outputDir);
  const current = job;
  let next = 0;
  const n = Math.min(16, Math.max(1, Math.round(Number(cfg.perf.concurrency)) || 1));
  // 0 = every CPU thread on the machine.
  const maxThreads = Math.min(os.cpus().length, Math.max(0, Math.round(Number(cfg.perf.maxThreads)) || 0)) || os.cpus().length;
  // Split CPU threads between parallel jobs so n encoders don't each grab every core.
  const threads = cfg.perf.limitThreads ? Math.max(1, Math.floor(maxThreads / n)) : 0;
  current.concurrency = n;
  const limiter = new CpuLimiter({ maxCores: maxThreads, power: cfg.perf.power });
  current.limiter = limiter;
  const encoder = await P.resolveEncoder(cfg.encode.encoder);
  current.encoder = encoder;

  async function worker() {
    while (!current.stopping && next < current.items.length) {
      const it = current.items[next++];
      if (it.status !== 'pending') continue;
      const found = cfg.skipExisting && N.findExisting(naming, cfg.outputDir, existing, it);
      if (found) { it.status = 'skipped'; it.progress = 1; it.outName = found; it.msg = 'Đã có file xuất'; continue; }
      it.status = 'running';
      const music = picker.next();
      it.outName = N.outputName(naming, { index: it.index, base: it.base, musicIndex: music ? musicFiles.indexOf(music) : null }) + '.mp4';
      try {
        const r = await P.processVideo(cfg, it.input, path.join(cfg.outputDir, it.outName), music, {
          threads,
          encoder,
          onProgress: (p) => { it.progress = p; },
          onSpawn: (proc) => {
            current.procs.add(proc);
            limiter.add(proc.pid);
            proc.on('close', () => current.procs.delete(proc));
            if (cfg.perf.lowPriority) { try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
          },
        });
        it.status = 'done'; it.progress = 1;
        it.msg = [ENC_LABEL[r.encoder] + (r.fellBack ? ' (GPU lỗi → CPU)' : ''), r.angle ?`xoay ${r.angle.toFixed(2)}°` : '', r.music ? `nhạc: ${path.basename(r.music)}` : ''].filter(Boolean).join(' · ');
      } catch (e) {
        it.status = current.stopping ? 'cancelled' : 'error';
        it.msg = e.message;
      }
    }
  }

  Promise.all(Array.from({ length: n }, worker)).then(() => {
    for (const it of current.items) if (it.status === 'pending') it.status = 'cancelled';
    limiter.stop();
    current.running = false;
    current.finishedAt = Date.now();
  });
}

function stopJob() {
  if (!job || !job.running) return;
  job.stopping = true;
  for (const p of job.procs) { try { p.kill(); } catch {} }
}

// ---------- native Windows pickers ----------
function pick(kind, initial) {
  const esc = (s) => String(s || '').replace(/'/g, "''");
  const dialog = kind === 'image'
    ? `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'Ảnh PNG/JPG|*.png;*.jpg;*.jpeg;*.webp|Tất cả|*.*'; if ('${esc(initial)}') { $d.InitialDirectory = Split-Path '${esc(initial)}' }; $ok = $d.ShowDialog($f); $res = $d.FileName`
    : `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = '${esc(initial)}'; $ok = $d.ShowDialog($f); $res = $d.SelectedPath`;
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms;
    $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; WindowState='Minimized'}; $f.Show(); $f.Activate();
    ${dialog}; $f.Close(); if ($ok -eq 'OK') { [Console]::Out.Write($res) }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.on('close', () => resolve(out.trim()));
    ps.on('error', () => resolve(''));
  });
}

// ---------- http ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const routes = {
  'GET /api/config': async () => loadConfig(),
  'GET /api/system': async () => ({
    cpus: os.cpus().length,
    encoders: await P.detectEncoders(),
    auto: await P.resolveEncoder('auto'),
  }),
  'POST /api/config': async (body) => { const cfg = merge(DEFAULTS, body); saveConfig(cfg); return { ok: true }; },
  'POST /api/pick': async (body) => ({ path: await pick(body.kind, body.initial) }),
  'POST /api/scan': async (body) => ({
    videos: P.listFiles(body.inputDir, P.VIDEO_EXT).length,
    music: (await P.listMusic(body.musicDir)).length,
  }),
  'POST /api/name-example': async (body) => {
    const cfg = merge(DEFAULTS, body);
    const videos = P.listFiles(cfg.inputDir, P.VIDEO_EXT);
    const first = videos[0] || 'ten-video.mp4';
    const base = path.basename(first, path.extname(first));
    return { example: N.outputName(cfg.naming, { index: 0, base, musicIndex: cfg.music.enabled ? 4 : null }) + '.mp4' };
  },
  'POST /api/preview': async (body) => {
    const cfg = merge(DEFAULTS, body);
    const videos = P.listFiles(cfg.inputDir, P.VIDEO_EXT);
    if (!videos.length) throw new Error('Không có video nào trong thư mục gốc');
    const i = Math.min(videos.length - 1, Math.max(0, Number(body.previewIndex) || 0));
    const [before, after] = await Promise.all([P.previewFrame(cfg, videos[i], { raw: true }), P.previewFrame(cfg, videos[i])]);
    return { before, after, name: path.basename(videos[i]), index: i, total: videos.length };
  },
  'POST /api/start': async (body) => { const cfg = merge(DEFAULTS, body); saveConfig(cfg); await startJob(cfg); return { ok: true }; },
  'POST /api/retry': async (body) => { const cfg = merge(DEFAULTS, body); saveConfig(cfg); await startJob(cfg, { retryErrors: true }); return { ok: true }; },
  'POST /api/stop': async () => { stopJob(); return { ok: true }; },
  'GET /api/status': async () => {
    if (!job) return { running: false, items: [] };
    const { procs, limiter, ...rest } = job;
    return rest;
  },
  'POST /api/open-output': async (body) => { if (body.dir && fs.existsSync(body.dir)) spawn('explorer.exe', [body.dir]); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }
  const handler = routes[`${req.method} ${url}`];
  if (!handler) return send(res, 404, { error: 'Not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await handler(body));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

const URL_BASE = `http://localhost:${PORT}`;
const openBrowser = () => { if (!process.env.NO_OPEN) exec(`start "" "${URL_BASE}"`); };

function listeningPid(port) {
  return new Promise((resolve) => exec('netstat -ano -p tcp', (err, out) => {
    const line = (out || '').split('\n').find((l) => new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING`).test(l));
    resolve(line ? Number(line.trim().split(/\s+/).pop()) : null);
  }));
}

// Port taken: if it's an older copy of this app that is idle, replace it; if it's busy, just open it.
async function handlePortInUse() {
  let status = null;
  try { status = await (await fetch(`${URL_BASE}/api/status`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
  if (!status) {
    console.log(`Cổng ${PORT} đang bị chương trình khác dùng. Đóng chương trình đó hoặc chạy với cổng khác: set PORT=5578 && node server.js`);
    process.exit(1);
  }
  if (status.running) {
    console.log('App đang chạy ở một cửa sổ khác và đang xử lý video → mở lại trang đó.');
    openBrowser();
    return setTimeout(() => process.exit(0), 1500);
  }
  const pid = await listeningPid(PORT);
  if (!pid) { console.log(`Không tìm được tiến trình giữ cổng ${PORT}.`); process.exit(1); }
  console.log('Đang tắt bản cũ của app đang chạy ở cửa sổ khác...');
  try { process.kill(pid); } catch {}
  setTimeout(() => server.listen(PORT, '127.0.0.1'), 800);
}

server.on('listening', () => {
  console.log(`Video Batch Editor đang chạy tại ${URL_BASE}  (Ctrl+C để tắt)`);
  openBrowser();
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !server.retried) { server.retried = true; handlePortInUse(); return; }
  console.error('Lỗi khởi động:', e.message);
  process.exit(1);
});

P.detectEncoders();
server.listen(PORT, '127.0.0.1');
