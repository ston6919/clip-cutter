#!/usr/bin/env node
/**
 * Clip Cutter dev server — static files + server-side transcription (system ffmpeg).
 *
 * Usage: node serve.mjs
 * Open:  http://localhost:4201
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4201;
const CHUNK_SEC = 300;
const DG_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=false&words=true';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readConfigValue(name) {
  try {
    const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    const m = cfg.match(new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']'));
    if (m) return m[1];
  } catch (_) {}
  return null;
}

function getDeepgramKey(headerKey) {
  if (headerKey?.trim()) return headerKey.trim();
  return readConfigValue('DEEPGRAM_KEY') || process.env.DEEPGRAM_API_KEY || null;
}

function getOpenRouterKey(headerKey) {
  if (headerKey?.trim()) return headerKey.trim();
  return readConfigValue('OPENROUTER_KEY') || process.env.OPENROUTER_API_KEY || null;
}

const OPENROUTER_MODEL = readConfigValue('OPENROUTER_MODEL') || process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffprobe failed — is ffmpeg installed?');
  return parseFloat(r.stdout.trim()) || 0;
}

function extractMp3(videoPath, outPath, start, end) {
  const args = ['-y', '-i', videoPath];
  if (start != null) args.push('-ss', String(start));
  if (end != null) args.push('-to', String(end));
  args.push('-vn', '-acodec', 'libmp3lame', '-q:a', '2', outPath);
  const r = spawnSync('ffmpeg', args, { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.slice(-400) || 'unknown error'}`);
}

async function deepgramTranscribe(mp3Path, key, attempt = 1) {
  const audio = fs.readFileSync(mp3Path); // small per-chunk MP3, not full video
  const res = await fetch(DG_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${key}`,
      'Content-Type': 'audio/mpeg',
    },
    body: audio,
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if ([408, 429, 503].includes(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return deepgramTranscribe(mp3Path, key, attempt + 1);
    }
    throw new Error(`Deepgram error ${res.status}${body ? ` — ${body.slice(0, 120)}` : ''}`);
  }
  return res.json();
}

function mergeWords(chunkResults) {
  const all = [];
  for (const { start, data } of chunkResults) {
    const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    for (const w of words) {
      all.push({ ...w, start: w.start + start, end: w.end + start });
    }
  }
  return all;
}

async function transcribeVideo(videoPath, key) {
  const duration = probeDuration(videoPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-cutter-'));
  const chunkResults = [];

  try {
    if (duration <= CHUNK_SEC) {
      const mp3 = path.join(tmp, 'audio.mp3');
      extractMp3(videoPath, mp3);
      const data = await deepgramTranscribe(mp3, key);
      chunkResults.push({ start: 0, data });
    } else {
      const n = Math.ceil(duration / CHUNK_SEC);
      for (let i = 0; i < n; i++) {
        const start = i * CHUNK_SEC;
        const end = Math.min((i + 1) * CHUNK_SEC, duration);
        const mp3 = path.join(tmp, `chunk_${i}.mp3`);
        console.log(`  chunk ${i + 1}/${n} (${start.toFixed(0)}s–${end.toFixed(0)}s)`);
        extractMp3(videoPath, mp3, start, end);
        const data = await deepgramTranscribe(mp3, key);
        chunkResults.push({ start, data });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const words = mergeWords(chunkResults);
  const transcript = chunkResults
    .map(c => c.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '')
    .join(' ')
    .trim();

  return { words, transcript, duration, hasAudio: true, chunkCount: chunkResults.length };
}

function streamBodyToFile(req, destPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Native ffmpeg export ──────────────────────────────────────────────
// Uploaded videos are cached server-side by id so "export all" reuses one upload.
const VIDEO_STORE = new Map(); // id -> { path, dir, name }

function outputDimensions(format) {
  if (format === '9:16') return [1080, 1920];
  if (format === '1:1') return [1080, 1080];
  return [1920, 1080];
}

function needsReframe(srcW, srcH, format) {
  if (!format || !srcW || !srcH) return false;
  const srcAspect = srcW / srcH;
  const [tw, th] = outputDimensions(format);
  return Math.abs(srcAspect - tw / th) > 0.02;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// zoom 1 = fill frame; <1 = letterbox; >1 = extra zoom. pan -1..1 when cropped.
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

function runFfmpeg(args, cwd) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', cwd });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed: ${(r.stderr || '').slice(-500) || 'unknown error'}`);
  }
}

// Cut/concat the selected segments into one clip (no captions).
function buildExportArgs(videoPath, segments, outPath, hasAudio, reframe) {
  const vf = reframe
    ? buildReframeFilter(reframe.srcW, reframe.srcH, reframe.format, reframe.panX, reframe.panY, reframe.zoom)
    : null;
  const vOut = vf ? '[outv2]' : '[outv]';

  if (segments.length === 1 && !vf) {
    const { start, end } = segments[0];
    const a = ['-y', '-i', videoPath, '-ss', String(start), '-to', String(end),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18'];
    if (hasAudio !== false) a.push('-c:a', 'aac'); else a.push('-an');
    a.push(outPath);
    return a;
  }

  if (segments.length === 1 && vf) {
    const { start, end } = segments[0];
    const a = ['-y', '-i', videoPath, '-ss', String(start), '-to', String(end),
      '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18'];
    if (hasAudio !== false) a.push('-c:a', 'aac'); else a.push('-an');
    a.push(outPath);
    return a;
  }

  const filters = [];
  segments.forEach((s, i) => {
    filters.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio !== false) filters.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const vcat = segments.map((_, i) => `[v${i}]`).join('');
  filters.push(`${vcat}concat=n=${segments.length}:v=1:a=0[outv]`);
  if (vf) filters.push(`[outv]${vf}[outv2]`);
  const a = ['-y', '-i', videoPath, '-filter_complex'];
  if (hasAudio !== false) {
    const acat = segments.map((_, i) => `[a${i}]`).join('');
    filters.push(`${acat}concat=n=${segments.length}:v=0:a=1[outa]`);
    a.push(filters.join(';'), '-map', vOut, '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac');
  } else {
    a.push(filters.join(';'), '-map', vOut,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an');
  }
  a.push(outPath);
  return a;
}

// Burn caption PNGs onto a finished clip via timed overlays (no libass/freetype needed).
// cues: [{ start, end, file }]  — file is a PNG path (browser-rendered: white text on black box).
function buildOverlayArgs(basePath, cues, outPath, hasAudio) {
  const a = ['-y', '-i', basePath];
  cues.forEach(c => a.push('-i', c.file));
  const filters = [];
  let label = '[0:v]';
  cues.forEach((c, i) => {
    const next = i === cues.length - 1 ? '[outv]' : `[v${i}]`;
    // bottom-centre, ~6% margin from the bottom edge; only visible during the cue
    filters.push(`${label}[${i + 1}:v]overlay=x=(W-w)/2:y=H-h-(H*0.06):enable='between(t\\,${c.start.toFixed(3)}\\,${c.end.toFixed(3)})'${next}`);
    label = next;
  });
  a.push('-filter_complex', filters.join(';'), '-map', '[outv]');
  if (hasAudio !== false) a.push('-map', '0:a?', '-c:a', 'copy');
  a.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', outPath);
  return a;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Deepgram-Key, X-Filename',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      transcribe: hasFfmpeg(),
      ffmpeg: hasFfmpeg(),
      openrouter: !!getOpenRouterKey(),
      model: OPENROUTER_MODEL,
    });
    return;
  }

  // AI auto-clip selection via OpenRouter.
  if (req.method === 'POST' && url.pathname === '/api/ai-clips') {
    const key = getOpenRouterKey(req.headers['x-openrouter-key']);
    if (!key) { sendJson(res, 401, { error: 'No OpenRouter API key — set OPENROUTER_KEY in clip-cutter/config.js or paste one.' }); return; }
    let spec;
    try { spec = JSON.parse((await readBody(req)).toString('utf8')); }
    catch (_) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const units = Array.isArray(spec.units) ? spec.units : [];
    if (!units.length) { sendJson(res, 400, { error: 'No transcript units provided' }); return; }
    const guidance = (spec.guidance || '').trim() || 'Pick the most compelling standalone clips.';
    const model = spec.model || OPENROUTER_MODEL;

    const unitList = units.map(u => `[${u.id}] ${u.text}`).join('\n');
    const system = [
      'You are a video editor that selects clips from a transcript.',
      'The transcript is split into numbered sentence units. Each clip is an ordered list of unit ids to keep (they will be cut and concatenated in that order).',
      'A unit may appear in more than one clip if relevant. Keep each clip coherent and self-contained.',
      'Respond with STRICT JSON only, no markdown, of the form:',
      '{"clips":[{"name":"Short clip name","reason":"why","units":[0,1,2]}]}',
      'Use 1-8 clips unless the guidance says otherwise. Unit ids must exist in the list.',
    ].join(' ');
    const user = `GUIDANCE:\n${guidance}\n\nTRANSCRIPT UNITS:\n${unitList}`;

    try {
      console.log(`AI clips: ${units.length} units, model=${model}`);
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:4201',
          'X-Title': 'Clip Cutter',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        sendJson(res, 502, { error: `OpenRouter error ${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}` });
        return;
      }
      const data = await r.json();
      let content = data?.choices?.[0]?.message?.content || '';
      content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let parsed;
      try { parsed = JSON.parse(content); }
      catch (_) {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
      }
      if (!parsed?.clips) { sendJson(res, 502, { error: 'Model did not return valid clip JSON', raw: content.slice(0, 300) }); return; }
      console.log(`  → ${parsed.clips.length} clips`);
      sendJson(res, 200, { clips: parsed.clips, model });
    } catch (e) {
      console.error('AI clips error:', e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // Cache an uploaded video server-side, return an id for later exports.
  if (req.method === 'POST' && url.pathname === '/api/export-upload') {
    if (!hasFfmpeg()) { sendJson(res, 500, { error: 'ffmpeg not found on PATH (brew install ffmpeg)' }); return; }
    const filename = (req.headers['x-filename'] || 'video.mp4').replace(/[^\w.\-]/g, '_');
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-cutter-export-'));
    const videoPath = path.join(dir, filename);
    try {
      await streamBodyToFile(req, videoPath);
      VIDEO_STORE.set(id, { path: videoPath, dir, name: filename });
      console.log(`Export upload cached: ${filename} (id=${id})`);
      sendJson(res, 200, { id });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // Run native ffmpeg to cut/concat one clip, stream the mp4 back.
  if (req.method === 'POST' && url.pathname === '/api/export') {
    if (!hasFfmpeg()) { sendJson(res, 500, { error: 'ffmpeg not found on PATH (brew install ffmpeg)' }); return; }
    let spec;
    try { spec = JSON.parse((await readBody(req)).toString('utf8')); }
    catch (_) { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
    const entry = VIDEO_STORE.get(spec.id);
    if (!entry) { sendJson(res, 404, { error: 'Video not found on server — re-upload (refresh clears it).' }); return; }
    const segments = spec.segments || [];
    if (!segments.length) { sendJson(res, 400, { error: 'No segments' }); return; }
    const outName = (spec.outName || 'clip.mp4').replace(/[^\w.\-]/g, '_');
    const outPath = path.join(entry.dir, outName);
    const captions = Array.isArray(spec.captions) ? spec.captions.filter(c => c.png) : [];
    const reframe = needsOutputProcessing(spec.videoWidth, spec.videoHeight, spec.aspectFormat, spec.frameZoom)
      ? {
          srcW: spec.videoWidth,
          srcH: spec.videoHeight,
          format: spec.aspectFormat,
          panX: spec.frameOffset?.x ?? 0,
          panY: spec.frameOffset?.y ?? 0,
          zoom: spec.frameZoom ?? 1,
        }
      : null;
    try {
      const reframeNote = reframe ? `, ${reframe.format} reframe` : '';
      console.log(`Export: ${outName} (${segments.length} segment(s)${captions.length ? `, ${captions.length} captions` : ''}${reframeNote})`);
      if (captions.length) {
        // Pass 1: cut/concat to an intermediate clip.
        const basePath = path.join(entry.dir, `_base_${Date.now()}.mp4`);
        runFfmpeg(buildExportArgs(entry.path, segments, basePath, spec.hasAudio, reframe));
        // Write caption PNGs, then Pass 2: overlay them timed on the base clip.
        const cues = captions.map((c, i) => {
          const file = path.join(entry.dir, `cap_${i}.png`);
          fs.writeFileSync(file, Buffer.from(c.png, 'base64'));
          return { start: c.start, end: c.end, file };
        });
        runFfmpeg(buildOverlayArgs(basePath, cues, outPath, spec.hasAudio));
        fs.rmSync(basePath, { force: true });
        cues.forEach(c => fs.rmSync(c.file, { force: true }));
      } else {
        runFfmpeg(buildExportArgs(entry.path, segments, outPath, spec.hasAudio, reframe));
      }
      const data = fs.readFileSync(outPath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': data.length,
        'Content-Disposition': `attachment; filename="${outName}"`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
      fs.rmSync(outPath, { force: true });
    } catch (e) {
      console.error('Export error:', e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/transcribe') {
    const key = getDeepgramKey(req.headers['x-deepgram-key']);
    if (!key) {
      sendJson(res, 401, { error: 'No Deepgram API key — add clip-cutter/config.js' });
      return;
    }
    if (!hasFfmpeg()) {
      sendJson(res, 500, { error: 'ffmpeg not found on PATH — install ffmpeg (brew install ffmpeg)' });
      return;
    }

    const filename = (req.headers['x-filename'] || 'video.mp4').replace(/[^\w.\-]/g, '_');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-cutter-upload-'));
    const videoPath = path.join(tmpDir, filename);

    try {
      console.log(`Transcribe: ${filename}`);
      await streamBodyToFile(req, videoPath);
      const result = await transcribeVideo(videoPath, key);
      console.log(`  done — ${result.words.length} words (${result.chunkCount} chunk(s))`);
      sendJson(res, 200, result);
    } catch (e) {
      console.error('Transcribe error:', e.message);
      sendJson(res, 500, { error: e.message });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, filePath);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Clip Cutter → http://localhost:${PORT}`);
  if (!hasFfmpeg()) console.warn('Warning: ffmpeg not on PATH — transcription will fail until installed.');
});
