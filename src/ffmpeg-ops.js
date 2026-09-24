const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ffmpegPath, ffprobePath } = require('./ffmpeg-bin');

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject); // e.g. binary missing / not executable
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// ---- probe: duration/width/height/codec/fps via ffprobe -----------------
async function probe(filePath) {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const { stdout } = await run(ffprobePath(), args);
  const data = JSON.parse(stdout);
  const vStream = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const aStream = (data.streams || []).find((s) => s.codec_type === 'audio');
  let fps = 0;
  if (vStream.avg_frame_rate && vStream.avg_frame_rate !== '0/0') {
    const [n, d] = vStream.avg_frame_rate.split('/').map(Number);
    fps = d ? n / d : 0;
  }
  return {
    duration: parseFloat(data.format?.duration || vStream.duration || 0),
    width: vStream.width || 0,
    height: vStream.height || 0,
    fps,
    videoCodec: vStream.codec_name || '',
    hasAudio: !!aStream,
    audioCodec: aStream?.codec_name || '',
  };
}

// ---- scene-cut detection via ffmpeg's `scene` filter ---------------------
// Maps the editor's existing "sensitivity" slider (5-150, lower = more cuts,
// same numbers the old JS pixel/histogram scan used) onto ffmpeg's scene
// score threshold (0-1, LOWER threshold = MORE cuts flagged), so the slider
// keeps working the same way for the user after switching detectors.
// This mapping is a starting point, not measured against a large clip set —
// note in HANDOFF.md that thresholds may need real-world tuning.
function sensitivityToThreshold(sensitivity) {
  const s = Math.max(5, Math.min(150, sensitivity || 30));
  return Math.max(0.03, Math.min(0.6, s / 200));
}

async function detectScenes(filePath, sensitivity) {
  const threshold = sensitivityToThreshold(sensitivity);
  const args = [
    '-i', filePath,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-an', '-f', 'null', '-',
  ];
  // ffmpeg writes progress/filter logs to stderr even on success, and `run()`
  // only rejects on non-zero exit, so this is safe to read from stderr here.
  const { stderr } = await run(ffmpegPath(), args);
  const raw = [];
  const re = /pts_time:([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) raw.push(parseFloat(m[1]));

  // A single real cut can make several consecutive frames cross the
  // threshold at once (motion blur, dissolves, etc.), which used to produce
  // a cluster of near-duplicate boundaries a few frames apart instead of a
  // single one. Collapse anything closer than minGap seconds into one
  // boundary, same as the JS fallback scanner below already does.
  const minGap = 0.25;
  const times = [];
  for (const t of raw) {
    if (!times.length || t - times[times.length - 1] >= minGap) times.push(t);
  }
  return { times, rawCount: raw.length, threshold }; // cut boundary timestamps in seconds, excluding 0 and duration
}

// ---- lightweight preview proxy (720p H.264) -------------------------------
async function makeProxy(filePath) {
  const outDir = path.join(os.tmpdir(), 'vem-proxies');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}-${Date.now()}.mp4`);

  const baseArgs = ['-y', '-i', filePath, '-vf', "scale=-2:720", '-c:a', 'aac', '-b:a', '128k'];
  try {
    // Prefer Apple's hardware encoder (fast, low CPU) where available.
    await run(ffmpegPath(), [...baseArgs, '-c:v', 'h264_videotoolbox', '-b:v', '4M', outPath]);
  } catch (err) {
    // Falls back to software encode on non-mac dev machines, or if
    // VideoToolbox isn't available for some reason.
    await run(ffmpegPath(), [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', outPath]);
  }
  return outPath;
}

module.exports = { probe, detectScenes, makeProxy, sensitivityToThreshold };
