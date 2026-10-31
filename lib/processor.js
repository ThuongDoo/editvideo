const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const FFMPEG = require('ffmpeg-static');
const FFPROBE = require('ffprobe-static').path;

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv', '.wmv', '.3gp', '.ts', '.mts'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'];

function listFiles(dir, exts) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function run(bin, args, { onStdout, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    if (onSpawn) onSpawn(proc);
    const out = [];
    let err = '';
    proc.stdout.on('data', (d) => {
      out.push(d);
      if (onStdout) onStdout(d.toString());
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}

async function probe(file, { audioOnly = false } = {}) {
  const { code, stdout, stderr } = await run(FFPROBE, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  if (code !== 0) throw new Error('Không đọc được video: ' + stderr.trim().split('\n').pop());
  const data = JSON.parse(stdout.toString());
  const hasAudio = (data.streams || []).some((s) => s.codec_type === 'audio');
  if (audioOnly) return { hasAudio };
  const v = (data.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('File không có hình ảnh');
  let rot = 0;
  if (v.tags && v.tags.rotate) rot = parseInt(v.tags.rotate, 10);
  for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rot = parseInt(sd.rotation, 10);
  let width = v.width, height = v.height;
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  return {
    width,
    height,
    duration: parseFloat(data.format && data.format.duration) || 0,
    hasAudio,
  };
}

// Music folder: audio files plus video-container files (e.g. audio-only .mp4) that carry an audio stream.
async function listMusic(dir) {
  const files = listFiles(dir, [...AUDIO_EXT, ...VIDEO_EXT]);
  const ok = await Promise.all(files.map(async (f) => {
    if (AUDIO_EXT.includes(path.extname(f).toLowerCase())) return true;
    try { return (await probe(f, { audioOnly: true })).hasAudio; } catch { return false; }
  }));
  return files.filter((_, i) => ok[i]);
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

function hexColor(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  return '0x' + (m ? m[1] : 'ffffff');
}

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${p.toFixed(4)}`).join(',');
}

// Pick the per-video random values once so a preview and a render can share them.
function pickRandom(cfg, { preview = false } = {}) {
  let angle = 0;
  if (cfg.rotate.enabled) {
    const lo = Math.min(num(cfg.rotate.min, 0), num(cfg.rotate.max, 0));
    const hi = Math.max(num(cfg.rotate.min, 0), num(cfg.rotate.max, 0));
    angle = preview ? hi : lo + Math.random() * (hi - lo);
    if (cfg.rotate.randomDirection && !preview && Math.random() < 0.5) angle = -angle;
  }
  return { angle };
}

function speedOf(cfg) {
  if (!cfg.speed.enabled) return 1;
  return Math.min(4, Math.max(0.25, num(cfg.speed.value, 1)));
}

// Video filter chain (without the frame-image overlay).
function videoChain(cfg, info, rnd, { forStill = false } = {}) {
  const W = even(info.width), H = even(info.height);
  const f = [];
  if (W !== info.width || H !== info.height) f.push(`scale=${W}:${H}`);
  const speed = speedOf(cfg);
  if (!forStill && speed !== 1) f.push(`setpts=PTS/${speed}`);
  const flipH = cfg.flip.enabled && cfg.flip.horizontal;
  const flipV = cfg.flip.enabled && cfg.flip.vertical;
  const a = rnd.angle;
  const rad = (a * Math.PI) / 180;

  let zoom = cfg.scale.enabled ? Math.max(1, num(cfg.scale.percent, 100) / 100) : 1;
  if (a !== 0 && cfg.scale.autoFill) {
    // Minimum zoom so the rotated frame has no black corners.
    const r = Math.abs(rad);
    const need = Math.cos(r) + Math.max(W / H, H / W) * Math.sin(r);
    zoom = Math.max(zoom, need);
  }

  if (a !== 0 || zoom > 1.0001) {
    // Flip + rotate + zoom + crop as one perspective remap: ~2x less CPU than the separate filters.
    const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([u, v]) => {
      const dx = (u - W / 2) / zoom, dy = (v - H / 2) / zoom;
      let sx = W / 2 + dx * Math.cos(rad) - dy * Math.sin(rad);
      let sy = H / 2 + dx * Math.sin(rad) + dy * Math.cos(rad);
      if (flipH) sx = W - sx;
      if (flipV) sy = H - sy;
      return [sx, sy];
    });
    const p = corners.map(([x, y], i) => `x${i}=${x.toFixed(3)}:y${i}=${y.toFixed(3)}`).join(':');
    f.push(`perspective=${p}:interpolation=linear:eval=init`);
  } else {
    if (flipH) f.push('hflip');
    if (flipV) f.push('vflip');
  }

  if (cfg.color.enabled) {
    f.push(`eq=brightness=${num(cfg.color.brightness, 0)}:contrast=${num(cfg.color.contrast, 1)}:saturation=${num(cfg.color.saturation, 1)}`);
  }

  if (cfg.frame.enabled && cfg.frame.mode === 'color') {
    const t = Math.max(1, Math.round((Math.min(W, H) * num(cfg.frame.thicknessPct, 3)) / 100));
    const op = Math.min(1, Math.max(0, num(cfg.frame.opacity, 1)));
    f.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${hexColor(cfg.frame.color)}@${op}:t=${t}`);
  }
  f.push('setsar=1');
  return { chain: f.join(','), W, H };
}

function useFrameImage(cfg) {
  return cfg.frame.enabled && cfg.frame.mode === 'image' && cfg.frame.image && fs.existsSync(cfg.frame.image);
}

function frameOverlay(cfg, W, H, inputIdx, src, dst) {
  const op = Math.min(1, Math.max(0, num(cfg.frame.opacity, 1)));
  return `[${inputIdx}:v]scale=${W}:${H},format=rgba,colorchannelmixer=aa=${op}[fr];` +
    `[${src}][fr]overlay=0:0:shortest=1:format=auto,format=yuv420p[${dst}]`;
}

// Shuffle-bag so every track is used once before any repeats.
class MusicPicker {
  constructor(files) { this.files = files; this.bag = []; this.last = null; }
  next() {
    if (!this.files.length) return null;
    if (!this.bag.length) {
      this.bag = [...this.files];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.last) this.bag.unshift(this.bag.pop());
    }
    this.last = this.bag.pop();
    return this.last;
  }
}

async function processVideo(cfg, input, output, music, { onProgress, onSpawn, threads = 0, encoder = 'cpu' } = {}) {
  const info = await probe(input);
  const rnd = pickRandom(cfg);
  const speed = speedOf(cfg);
  const outDur = info.duration / speed;
  const { chain, W, H } = videoChain(cfg, info, rnd);

  const args = ['-hide_banner', '-y'];
  if (threads > 0) args.push('-filter_complex_threads', String(threads));
  args.push('-i', input);
  let idx = 1;
  let musicIdx = -1, frameIdx = -1;
  if (music) { args.push('-stream_loop', '-1', '-i', music); musicIdx = idx++; }
  if (useFrameImage(cfg)) { args.push('-loop', '1', '-i', cfg.frame.image); frameIdx = idx++; }

  const graph = [];
  if (frameIdx >= 0) {
    graph.push(`[0:v]${chain}[v0]`, frameOverlay(cfg, W, H, frameIdx, 'v0', 'vout'));
  } else {
    graph.push(`[0:v]${chain},format=yuv420p[vout]`);
  }

  const keepOriginal = !cfg.mute.enabled && info.hasAudio;
  let audioOut = null;
  if (music) {
    const vol = num(cfg.music.volume, 1);
    const fade = Math.max(0, num(cfg.music.fadeOut, 0));
    let m = `[${musicIdx}:a]atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol}`;
    if (fade > 0 && outDur > fade) m += `,afade=t=out:st=${(outDur - fade).toFixed(3)}:d=${fade}`;
    if (keepOriginal) {
      graph.push(`${m}[mus]`, `[0:a]${atempoChain(speed)}[orig]`, `[orig][mus]amix=inputs=2:duration=first:normalize=0[aout]`);
    } else {
      graph.push(`${m}[aout]`);
    }
    audioOut = '[aout]';
  } else if (keepOriginal) {
    graph.push(`[0:a]${atempoChain(speed)}[aout]`);
    audioOut = '[aout]';
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (audioOut) args.push('-map', audioOut, '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  const tmp = output + '.part.mp4';
  const attempt = (enc) => run(FFMPEG, [
    ...args,
    ...encoderArgs(enc, cfg),
    '-movflags', '+faststart',
    ...(threads > 0 ? ['-threads', String(threads)] : []),
    '-t', outDur.toFixed(3),
    '-progress', 'pipe:1', '-nostats',
    tmp,
  ], {
    onSpawn,
    onStdout: (s) => {
      const m = /out_time_(?:us|ms)=(\d+)/.exec(s);
      if (m && onProgress && outDur > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / outDur));
    },
  });

  let used = encoder;
  let { code, stderr } = await attempt(used);
  if (code !== 0 && code !== null && used !== 'cpu') {
    // GPU encoder failed (driver, session limit, odd size...): redo this video on CPU.
    if (onProgress) onProgress(0);
    used = 'cpu';
    ({ code, stderr } = await attempt(used));
  }
  if (code !== 0) {
    try { fs.unlinkSync(tmp); } catch {}
    const lines = stderr.trim().split('\n').filter((l) => !/^\s*(frame=|size=)/.test(l));
    throw new Error(code === null ? 'Đã dừng' : lines.slice(-3).join(' | '));
  }
  fs.renameSync(tmp, output);
  return { angle: rnd.angle, music, duration: outDur, encoder: used, fellBack: used !== encoder };
}

const ENCODER_NAMES = { cpu: 'libx264', nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' };

// GPU encoders need a higher quality number than x264's CRF to land at a similar file size.
// With a bitrate cap, x264/NVENC keep quality mode but never exceed the cap (light videos stay small);
// QSV/AMF have no capped-quality mode, so they switch to VBR averaging 3/4 of the cap.
function encoderArgs(enc, cfg) {
  const crf = num(cfg.encode.crf, 20);
  const kbps = cfg.encode.limitBitrate ? Math.round(Math.min(100, Math.max(0.5, num(cfg.encode.maxBitrate, 8))) * 1000) : 0;
  const cap = kbps ? ['-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`] : [];
  const vbr = kbps ? ['-b:v', `${Math.round(kbps * 0.75)}k`, ...cap] : [];
  switch (enc) {
    case 'nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(crf + 3), '-b:v', '0', ...cap, '-pix_fmt', 'yuv420p'];
    case 'qsv': return kbps
      ? ['-c:v', 'h264_qsv', '-preset', 'medium', ...vbr, '-pix_fmt', 'nv12']
      : ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(crf + 3), '-pix_fmt', 'nv12'];
    case 'amf': return kbps
      ? ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak', ...vbr, '-pix_fmt', 'yuv420p']
      : ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf + 2), '-qp_p', String(crf + 4), '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', 'libx264', '-preset', cfg.encode.preset || 'veryfast', '-crf', String(crf), ...cap, '-pix_fmt', 'yuv420p'];
  }
}

// Which hardware encoders actually work on this machine (tiny test encode each).
let encoderCache = null;
function detectEncoders() {
  if (!encoderCache) {
    encoderCache = Promise.all(['nvenc', 'qsv', 'amf'].map(async (e) => {
      const { code } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=0.5',
        '-c:v', ENCODER_NAMES[e], '-f', 'null', '-']).catch(() => ({ code: 1 }));
      return code === 0 ? e : null;
    })).then((list) => ['cpu', ...list.filter(Boolean)]);
  }
  return encoderCache;
}

async function resolveEncoder(choice) {
  const available = await detectEncoders();
  if (!choice || choice === 'auto') return ['nvenc', 'qsv', 'amf'].find((e) => available.includes(e)) || 'cpu';
  return available.includes(choice) ? choice : 'cpu';
}

// Single JPEG frame for the preview panel; `raw` skips every effect.
async function previewFrame(cfg, input, { raw = false } = {}) {
  const info = await probe(input);
  const t = Math.min(1, info.duration / 2);
  const args = ['-hide_banner', '-ss', String(t), '-i', input];
  if (raw) {
    args.push('-vf', `scale=${even(info.width)}:${even(info.height)}`);
  } else {
    const { chain, W, H } = videoChain(cfg, info, pickRandom(cfg, { preview: true }), { forStill: true });
    if (useFrameImage(cfg)) {
      args.push('-i', cfg.frame.image, '-filter_complex', `[0:v]${chain}[v0];` + frameOverlay(cfg, W, H, 1, 'v0', 'vout'), '-map', '[vout]');
    } else {
      args.push('-vf', chain);
    }
  }
  args.push('-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
  const { code, stdout, stderr } = await run(FFMPEG, args);
  if (code !== 0 || !stdout.length) throw new Error(stderr.trim().split('\n').slice(-2).join(' | '));
  return 'data:image/jpeg;base64,' + stdout.toString('base64');
}

module.exports = { VIDEO_EXT, AUDIO_EXT, listFiles, listMusic, probe, detectEncoders, resolveEncoder, processVideo, previewFrame, MusicPicker };
