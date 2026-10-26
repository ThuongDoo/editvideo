const fs = require('fs');
const path = require('path');

const MUSIC_MARK = '\u0000';

const pad = (n, width) => String(n).padStart(Math.max(1, Number(width) || 1), '0');
const clean = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PARTS = ['prefix', 'index', 'name', 'music', 'suffix'];

function partOrder(n) {
  const order = Array.isArray(n.order) ? n.order.filter((p, i, a) => PARTS.includes(p) && a.indexOf(p) === i) : [];
  return [...order, ...PARTS.filter((p) => !order.includes(p))];
}

// Output file name (no extension): the enabled parts in the user's order, joined by the separator.
// `index` is the 0-based position of the video in the input folder, `musicIndex` the 0-based track position.
function outputName(n, { index, base, musicIndex }) {
  const sep = clean(n.separator);
  const value = {
    prefix: clean(n.prefix),
    index: n.addIndex ? pad(index + (Number(n.indexStart) || 0), n.indexPad) : '',
    // Without an STT the original name is the only thing keeping names unique, so it can't be dropped.
    name: n.keepName || !n.addIndex ? base : '',
    music: !n.addMusicIndex || musicIndex == null ? ''
      : musicIndex === MUSIC_MARK ? MUSIC_MARK : clean(n.musicLabel) + pad(musicIndex + 1, n.musicPad),
    suffix: clean(n.suffix),
  };
  // Don't double the separator when a custom text already starts/ends with it (e.g. prefix "Ve_").
  return partOrder(n).map((p) => value[p]).filter(Boolean).reduce((acc, p) => {
    if (!acc || !sep) return acc + p;
    const left = acc.endsWith(sep), right = p.startsWith(sep);
    if (left && right) return acc + p.slice(sep.length);
    return left || right ? acc + p : acc + sep + p;
  }, '');
}

// Finds an already-exported file for this video. When the name carries a music number the track
// is random per run, so any music number counts as a match.
function findExisting(n, outputDir, existing, { index, base }) {
  if (!n.addMusicIndex) {
    const file = outputName(n, { index, base }) + '.mp4';
    return fs.existsSync(path.join(outputDir, file)) ? file : null;
  }
  const pattern = escapeRe(outputName(n, { index, base, musicIndex: MUSIC_MARK }))
    .replace(MUSIC_MARK, escapeRe(clean(n.musicLabel)) + '\\d+');
  const re = new RegExp(`^${pattern}\\.mp4$`, 'i');
  return existing.find((f) => re.test(f)) || null;
}

module.exports = { PARTS, outputName, findExisting };
