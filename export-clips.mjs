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

function run(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

for (const clip of spec.clips || []) {
  const segs = clip.segments || [];
  if (!segs.length) continue;
  const outName = clip.filename || `${clip.exportName || 'clip'}.mp4`;
  const outPath = path.join(outDir, outName);
  console.log(`\n→ ${outName} (${segs.length} segment${segs.length !== 1 ? 's' : ''})`);

  if (segs.length === 1) {
    const { start, end } = segs[0];
    run(`ffmpeg -y -i "${video}" -ss ${start} -to ${end} -c:v libx264 -preset fast -crf 18 ${spec.hasAudio !== false ? '-c:a aac' : '-an'} "${outPath}"`);
    continue;
  }

  const filters = [];
  segs.forEach((s, i) => {
    filters.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
    if (spec.hasAudio !== false) filters.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const vcat = segs.map((_, i) => `[v${i}]`).join('');
  filters.push(`${vcat}concat=n=${segs.length}:v=1:a=0[outv]`);
  let maps = '-map "[outv]"';
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
