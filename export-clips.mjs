#!/usr/bin/env node
/**
 * Export clips from a Clip Cutter spec JSON (native ffmpeg — fast, no browser limits).
 *
 * Usage:
 *   node export-clips.mjs /path/to/video.mp4 /path/to/clip-spec.json
 *   node export-clips.mjs /path/to/video.mp4 /path/to/clip-spec.json --out ./exports
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
let outDir = process.cwd();
if (outFlag !== -1) {
  outDir = path.resolve(args[outFlag + 1] || '.');
  args.splice(outFlag, 2);
}

const [videoPath, specPath] = args;
if (!videoPath || !specPath) {
  console.error('Usage: node export-clips.mjs <video.mp4> <clip-spec.json> [--out <dir>]');
  process.exit(1);
}

const video = path.resolve(videoPath);
const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
if (!fs.existsSync(video)) {
  console.error(`Video not found: ${video}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

function outputDimensions(format) {
  if (format === '9:16') return [1080, 1920];
  if (format === '1:1') return [1080, 1080];
  return [1920, 1080];
}

function needsReframe(srcW, srcH, format) {
  if (!format || !srcW || !srcH) return false;
  const [tw, th] = outputDimensions(format);
  return Math.abs((srcW / srcH) - (tw / th)) > 0.02;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

const MIN_FRAME_ZOOM = 0.1;

function computeFrameScale(srcW, srcH, tw, th, zoom) {
  const fitScale = Math.min(tw / srcW, th / srcH);
  const coverScale = Math.max(tw / srcW, th / srcH);
  const aspectsMatch = Math.abs((srcW / srcH) - (tw / th)) < 0.02;
  const z = Number(zoom);
  if (!Number.isFinite(z) || z <= 0) {
    return aspectsMatch ? fitScale * MIN_FRAME_ZOOM : fitScale;
  }
  const zc = clamp(z, MIN_FRAME_ZOOM, 2.5);
  if (aspectsMatch) return fitScale * zc;
  if (zc <= 1) return fitScale + zc * (coverScale - fitScale);
  return coverScale * zc;
}

function needsOutputProcessing(srcW, srcH, format, zoom) {
  if (!format || !srcW || !srcH) return false;
  const z = Number(zoom);
  if (z <= 0 || Math.abs((z || 1) - 1) > 0.01) return true;
  return needsReframe(srcW, srcH, format);
}

function even(n) { const v = Math.round(n); return v % 2 ? v + 1 : v; }

function buildReframeFilter(srcW, srcH, format, panX = 0, panY = 0, zoom = 1) {
  const [tw, th] = outputDimensions(format);
  const px = clamp(Number(panX) || 0, -1, 1);
  const py = clamp(Number(panY) || 0, -1, 1);
  const s = computeFrameScale(srcW, srcH, tw, th, zoom);
  const sw = even(srcW * s);
  const sh = even(srcH * s);
  if (sw <= tw && sh <= th) {
    const padX = Math.round((tw - sw) / 2);
    const padY = Math.round((th - sh) / 2);
    return `scale=${sw}:${sh},pad=${tw}:${th}:${padX}:${padY}:color=black`;
  }
  const cropX = Math.round((sw - tw) / 2 + px * (sw - tw) / 2);
  const cropY = Math.round((sh - th) / 2 + py * (sh - th) / 2);
  return `scale=${sw}:${sh},crop=${tw}:${th}:${cropX}:${cropY}`;
}

function run(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const srcW = spec.videoWidth || 1920;
const srcH = spec.videoHeight || 1080;
const aspectFormat = spec.aspectFormat || null;

for (const clip of spec.clips || []) {
  const segs = clip.segments || [];
  if (!segs.length) continue;
  const outName = clip.filename || `${clip.exportName || 'clip'}.mp4`;
  const outPath = path.join(outDir, outName);
  const reframe = needsOutputProcessing(srcW, srcH, aspectFormat, clip.frameZoom)
    ? buildReframeFilter(srcW, srcH, aspectFormat, clip.frameOffset?.x, clip.frameOffset?.y, clip.frameZoom ?? 1)
    : null;
  console.log(`\n→ ${outName} (${segs.length} segment${segs.length !== 1 ? 's' : ''}${reframe ? `, ${aspectFormat}` : ''})`);

  if (segs.length === 1) {
    const { start, end } = segs[0];
    const vf = reframe ? `-vf "${reframe}"` : '';
    run(`ffmpeg -y -i "${video}" -ss ${start} -to ${end} ${vf} -c:v libx264 -preset fast -crf 18 ${spec.hasAudio !== false ? '-c:a aac' : '-an'} "${outPath}"`);
    continue;
  }

  const filters = [];
  segs.forEach((s, i) => {
    filters.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
    if (spec.hasAudio !== false) filters.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const vcat = segs.map((_, i) => `[v${i}]`).join('');
  filters.push(`${vcat}concat=n=${segs.length}:v=1:a=0[outv]`);
  const vOut = reframe ? '[outv2]' : '[outv]';
  if (reframe) filters.push(`[outv]${reframe}[outv2]`);
  let maps = `-map "${vOut}"`;
  if (spec.hasAudio !== false) {
    const acat = segs.map((_, i) => `[a${i}]`).join('');
    filters.push(`${acat}concat=n=${segs.length}:v=0:a=1[outa]`);
    maps += ' -map "[outa]" -c:a aac';
  } else {
    maps += ' -an';
  }
  run(`ffmpeg -y -i "${video}" -filter_complex "${filters.join(';')}" ${maps} -c:v libx264 -preset fast -crf 18 "${outPath}"`);
}

console.log(`\nDone — clips saved to ${outDir}`);
