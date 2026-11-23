import { MESH_POINTS, delaunay, depthFromOutline, featherAlpha, filterTriangles, bbox } from './geometry.js';

const $ = id => document.getElementById(id);
const ui = {
  engine: $('engine'), srcFile: $('srcFile'), srcImg: $('srcImg'), srcStatus: $('srcStatus'),
  tgtFile: $('tgtFile'), tgtStatus: $('tgtStatus'), out: $('out'), placeholder: $('placeholder'),
  btnPreview: $('btnPreview'), btnRender: $('btnRender'), btnStop: $('btnStop'), fps: $('fps'),
  progWrap: $('progWrap'), prog: $('prog'), vid: $('vid'), tgtImg: $('tgtImg'),
  optFaces: $('optFaces'), optRes: $('optRes'), optOpacity: $('optOpacity'), optFeather: $('optFeather'),
  optSmooth: $('optSmooth'), optColor: $('optColor'), optMouth: $('optMouth'), optEyes: $('optEyes'),
  optLabel: $('optLabel'),
};

const S = {
  lm: null, mode: null, delegate: '',
  src: null,            // { pts:[{x,y}], tris, depth, mean:[r,g,b] }
  tgtType: null,        // 'video' | 'image'
  running: false, recording: false, recorder: null, chunks: [],
  smooth: [], gains: [], frame: 0, lastTs: 0, fpsT: 0, fpsN: 0,
  audio: null,          // { ctx, dest, out }
};

const setStatus = (el, text, cls = '') => { el.textContent = text; el.className = 'status ' + cls; };

/* ---------------- Engine (MediaPipe Face Landmarker, fully offline) ---------------- */
async function initEngine() {
  try {
    const { FaceLandmarker, FilesetResolver } = await import('./vendor/vision_bundle.js');
    const vision = await FilesetResolver.forVisionTasks('./vendor/wasm');
    for (const delegate of ['GPU', 'CPU']) {
      try {
        S.lm = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: './models/face_landmarker.task', delegate },
          runningMode: 'IMAGE', numFaces: 4,
          minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        S.mode = 'IMAGE'; S.delegate = delegate; break;
      } catch (e) { console.warn('delegate failed', delegate, e); }
    }
    if (!S.lm) throw new Error('could not start face model');
    ui.engine.textContent = 'Engine ready · ' + S.delegate;
  } catch (e) {
    console.error(e);
    ui.engine.textContent = 'Engine failed to load';
    ui.engine.style.color = 'var(--bad)';
  }
  refreshButtons();
}

async function setMode(m) {
  if (S.mode !== m) { await S.lm.setOptions({ runningMode: m }); S.mode = m; }
}
const nextTs = () => (S.lastTs = Math.max(S.lastTs + 1, performance.now()));

/* ---------------- WebGL renderer ---------------- */
const gl$ = document.createElement('canvas');
const gl = gl$.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, alpha: false, antialias: true });
const out2d = ui.out.getContext('2d');
const probe = document.createElement('canvas'); probe.width = probe.height = 24;
const probe2d = probe.getContext('2d', { willReadFrequently: true });

function program(vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const quadProg = program(
  `attribute vec2 p; varying vec2 uv;
   void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }`,
  `precision mediump float; varying vec2 uv; uniform sampler2D t;
   void main(){ gl_FragColor = vec4(texture2D(t, uv).rgb, 1.); }`);

const meshProg = program(
  `attribute vec2 a_pos; attribute vec2 a_uv; attribute float a_alpha;
   uniform vec2 u_res; varying vec2 v_uv; varying float v_a;
   void main(){ v_uv = a_uv; v_a = a_alpha;
     vec2 c = a_pos / u_res * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0., 1.); }`,
  `precision mediump float; varying vec2 v_uv; varying float v_a;
   uniform sampler2D u_src; uniform vec3 u_gain; uniform float u_opacity;
   void main(){ vec3 c = clamp(texture2D(u_src, v_uv).rgb * u_gain, 0., 1.);
     gl_FragColor = vec4(c, v_a * u_opacity); }`);

const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const posBuf = gl.createBuffer(), uvBuf = gl.createBuffer(), alphaBuf = gl.createBuffer(), idxBuf = gl.createBuffer();
let idxCount = 0;
const posArr = new Float32Array(MESH_POINTS * 2);

function makeTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}
const frameTex = makeTex(), srcTex = makeTex();

function rebuildMesh() {
  if (!S.src) return;
  const tris = filterTriangles(S.src.tris, { keepMouth: ui.optMouth.checked, keepEyes: ui.optEyes.checked });
  const idx = new Uint16Array(tris.flat());
  idxCount = idx.length;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, alphaBuf);
  gl.bufferData(gl.ARRAY_BUFFER, featherAlpha(S.src.depth, +ui.optFeather.value), gl.STATIC_DRAW);
}

function attr(prog, name, buf, size) {
  const loc = gl.getAttribLocation(prog, name);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  return loc;
}

/* ---------------- Colour matching ---------------- */
function meanColor(el, elW, elH, pts) {
  const b = bbox(pts);
  // sample the central cheeks/nose area so hair and background don't skew it
  const sx = (b.x0 + b.w * 0.25) * elW, sy = (b.y0 + b.h * 0.3) * elH;
  const sw = Math.max(2, b.w * 0.5 * elW), sh = Math.max(2, b.h * 0.45 * elH);
  probe2d.drawImage(el, sx, sy, sw, sh, 0, 0, 24, 24);
  const d = probe2d.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, bl = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; }
  const n = d.length / 4;
  return [r / n, g / n, bl / n];
}

/* ---------------- Source face ---------------- */
ui.srcFile.addEventListener('change', async () => {
  const f = ui.srcFile.files[0]; if (!f || !S.lm) return;
  setStatus(ui.srcStatus, 'Finding face…');
  const img = ui.srcImg;
  img.src = URL.createObjectURL(f);
  await img.decode();
  img.hidden = false;
  stop();
  await setMode('IMAGE');
  const res = S.lm.detect(img);
  const faces = res.faceLandmarks || [];
  if (!faces.length) { S.src = null; setStatus(ui.srcStatus, 'No face found — try a clearer photo', 'bad'); refreshButtons(); return; }
  const face = largest(faces).slice(0, MESH_POINTS);
  const W = img.naturalWidth, H = img.naturalHeight;
  const tris = delaunay(face.map(p => [p.x * W, p.y * H]));
  S.src = { pts: face, tris, depth: depthFromOutline(tris, MESH_POINTS), mean: meanColor(img, W, H, face) };

  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(face.flatMap(p => [p.x, p.y])), gl.STATIC_DRAW);
  rebuildMesh();
  setStatus(ui.srcStatus, `Face ready${faces.length > 1 ? ' (used the largest of ' + faces.length + ')' : ''}`, 'ok');
  refreshButtons();
  redrawStill();
});

function largest(faces) {
  let best = faces[0], area = -1;
  for (const f of faces) { const b = bbox(f); if (b.w * b.h > area) { area = b.w * b.h; best = f; } }
  return best;
}

/* ---------------- Target ---------------- */
ui.tgtFile.addEventListener('change', async () => {
  const f = ui.tgtFile.files[0]; if (!f) return;
  stop();
  S.smooth = []; S.gains = [];
  const url = URL.createObjectURL(f);
  if (f.type.startsWith('image/')) {
    S.tgtType = 'image';
    ui.tgtImg.src = url; await ui.tgtImg.decode();
    sizeCanvas(ui.tgtImg.naturalWidth, ui.tgtImg.naturalHeight);
    setStatus(ui.tgtStatus, `Photo ${ui.tgtImg.naturalWidth}×${ui.tgtImg.naturalHeight}`, 'ok');
  } else {
    S.tgtType = 'video';
    const v = ui.vid;
    v.src = url; v.load();
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('cannot play this video')); })
      .catch(e => { setStatus(ui.tgtStatus, e.message, 'bad'); S.tgtType = null; });
    if (!S.tgtType) { refreshButtons(); return; }
    sizeCanvas(v.videoWidth, v.videoHeight);
    setStatus(ui.tgtStatus, `Video ${v.videoWidth}×${v.videoHeight} · ${v.duration.toFixed(1)} s`, 'ok');
  }
  ui.placeholder.hidden = true;
  refreshButtons();
  redrawStill();
});

function sizeCanvas(w, h) {
  const max = +ui.optRes.value, k = Math.min(1, max / Math.max(w, h));
  const W = Math.round(w * k / 2) * 2, H = Math.round(h * k / 2) * 2;
  ui.out.width = gl$.width = W; ui.out.height = gl$.height = H;
}

/* ---------------- Per-frame pipeline ---------------- */
function processFrame(el, elW, elH, faces) {
  const W = gl$.width, H = gl$.height;
  gl.viewport(0, 0, W, H);
  gl.disable(gl.BLEND);

  // 1. target frame
  gl.useProgram(quadProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
  gl.uniform1i(gl.getUniformLocation(quadProg, 't'), 0);
  const qLoc = attr(quadProg, 'p', quadBuf, 2);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disableVertexAttribArray(qLoc);

  // 2. swapped faces
  if (S.src && faces.length) {
    let list = faces;
    if (ui.optFaces.value === 'largest') list = [largest(faces)];
    const smoothK = list.length === 1 ? +ui.optSmooth.value / 100 : 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(meshProg);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(meshProg, 'u_src'), 0);
    gl.uniform2f(gl.getUniformLocation(meshProg, 'u_res'), W, H);
    gl.uniform1f(gl.getUniformLocation(meshProg, 'u_opacity'), +ui.optOpacity.value / 100);
    const locs = [attr(meshProg, 'a_uv', uvBuf, 2), attr(meshProg, 'a_alpha', alphaBuf, 1)];

    list.forEach((face, fi) => {
      // landmark stabilisation (exponential smoothing)
      let prev = S.smooth[fi];
      if (!prev || smoothK === 0) prev = S.smooth[fi] = new Float32Array(MESH_POINTS * 2).fill(NaN);
      for (let i = 0; i < MESH_POINTS; i++) {
        const x = face[i].x * W, y = face[i].y * H;
        const px = prev[i * 2], py = prev[i * 2 + 1];
        const nx = Number.isNaN(px) ? x : px * smoothK + x * (1 - smoothK);
        const ny = Number.isNaN(py) ? y : py * smoothK + y * (1 - smoothK);
        prev[i * 2] = posArr[i * 2] = nx; prev[i * 2 + 1] = posArr[i * 2 + 1] = ny;
      }
      // colour gain, refreshed every few frames
      let gain = S.gains[fi] || [1, 1, 1];
      if (ui.optColor.checked) {
        if (!S.gains[fi] || S.frame % 4 === 0) {
          const t = meanColor(el, elW, elH, face);
          const g = t.map((v, c) => Math.min(1.8, Math.max(0.5, (v + 8) / (S.src.mean[c] + 8))));
          gain = S.gains[fi] ? gain.map((o, c) => o * 0.7 + g[c] * 0.3) : g;
          S.gains[fi] = gain;
        }
      } else gain = [1, 1, 1];
      gl.uniform3f(gl.getUniformLocation(meshProg, 'u_gain'), gain[0], gain[1], gain[2]);
      locs.push(attr(meshProg, 'a_pos', posBuf, 2));
      gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_SHORT, 0);
    });
    locs.forEach(l => gl.disableVertexAttribArray(l));
  } else if (!faces.length) {
    S.smooth = [];
  }

  // 3. composite + label
  out2d.drawImage(gl$, 0, 0);
  if (ui.optLabel.checked) {
    const fs = Math.max(12, Math.round(H * 0.028));
    out2d.font = `600 ${fs}px system-ui, sans-serif`;
    out2d.textAlign = 'right'; out2d.textBaseline = 'bottom';
    out2d.shadowColor = 'rgba(0,0,0,.6)'; out2d.shadowBlur = 4;
    out2d.fillStyle = 'rgba(255,255,255,.8)';
    out2d.fillText('AI face swap', W - fs * 0.6, H - fs * 0.5);
    out2d.shadowBlur = 0;
  }
  S.frame++;
}

function detectVideoFrame() {
  const v = ui.vid;
  if (v.readyState < 2) return;
  const res = S.lm.detectForVideo(v, nextTs());
  processFrame(v, v.videoWidth, v.videoHeight, res.faceLandmarks || []);
  S.fpsN++;
  const now = performance.now();
  if (now - S.fpsT > 1000) { ui.fps.textContent = `${S.fpsN} fps`; S.fpsN = 0; S.fpsT = now; }
  if (S.recording && v.duration) ui.prog.style.width = (100 * v.currentTime / v.duration).toFixed(1) + '%';
}

function loop() {
  if (!S.running) return;
  try { detectVideoFrame(); } catch (e) { console.error(e); }
  if ('requestVideoFrameCallback' in ui.vid) ui.vid.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

async function redrawStill() {
  if (!S.lm || !S.tgtType || S.running) return;
  if (S.tgtType === 'image') {
    await setMode('IMAGE');
    const im = ui.tgtImg;
    const res = S.lm.detect(im);
    processFrame(im, im.naturalWidth, im.naturalHeight, res.faceLandmarks || []);
  } else {
    await setMode('VIDEO');
    detectVideoFrame();
  }
}

/* ---------------- Audio routing (keeps original sound in the recording) ---------------- */
function ensureAudio() {
  if (S.audio) { S.audio.ctx.resume(); return S.audio; }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = ctx.createMediaElementSource(ui.vid);
    const dest = ctx.createMediaStreamDestination();
    const out = ctx.createGain();
    srcNode.connect(dest); srcNode.connect(out); out.connect(ctx.destination);
    S.audio = { ctx, dest, out };
  } catch (e) { console.warn('audio routing unavailable', e); S.audio = null; }
  return S.audio;
}

/* ---------------- Controls ---------------- */
ui.btnPreview.onclick = async () => {
  if (S.tgtType === 'image') return redrawStill();
  await setMode('VIDEO');
  ensureAudio();
  S.running = true; refreshButtons();
  if (ui.vid.ended) ui.vid.currentTime = 0;
  await ui.vid.play();
  loop();
};

ui.btnRender.onclick = async () => {
  if (S.tgtType === 'image') {
    await redrawStill();
    ui.out.toBlob(b => saveBlob(b, `faceswap-${stamp()}.png`), 'image/png');
    return;
  }
  await setMode('VIDEO');
  const audio = ensureAudio();
  const v = ui.vid;
  v.pause();
  v.currentTime = 0;
  await new Promise(r => { v.onseeked = r; });
  S.smooth = []; S.gains = [];

  const stream = ui.out.captureStream(30);
  if (audio) audio.dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) { alert('This device cannot record video.'); return; }
  S.chunks = [];
  S.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  S.recorder.ondataavailable = e => e.data.size && S.chunks.push(e.data);
  S.recorder.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(S.chunks, { type: mime.split(';')[0] });
    ui.progWrap.hidden = true;
    if (S.keepRecording) saveBlob(blob, `faceswap-${stamp()}.${ext}`);
  };
  S.keepRecording = true;
  S.recording = true; S.running = true;
  ui.progWrap.hidden = false; ui.prog.style.width = '0%';
  refreshButtons();
  v.onended = () => finishRender();
  S.recorder.start(1000);
  await v.play();
  loop();
};

function finishRender() {
  if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop();
  S.recording = false; S.running = false;
  refreshButtons();
}

function stop() {
  if (S.recording) { S.keepRecording = true; finishRender(); }  // save what was rendered so far
  S.running = false;
  ui.vid.pause();
  refreshButtons();
}
ui.btnStop.onclick = stop;
ui.vid.addEventListener('ended', () => { if (!S.recording) { S.running = false; refreshButtons(); } });

function refreshButtons() {
  const ready = !!(S.lm && S.src && S.tgtType);
  ui.btnPreview.disabled = !ready || S.running;
  ui.btnRender.disabled = !ready || S.running;
  ui.btnStop.disabled = !S.running;
  ui.srcFile.disabled = ui.tgtFile.disabled = S.recording || !S.lm;
  ui.btnRender.textContent = S.tgtType === 'image' ? '⬇ Save photo' : '⏺ Render & save';
}

for (const [inp, outId, fmt] of [[ui.optOpacity, 'vOpacity', v => v + '%'], [ui.optFeather, 'vFeather', v => v],
  [ui.optSmooth, 'vSmooth', v => v + '%']]) {
  inp.addEventListener('input', () => { $(outId).textContent = fmt(inp.value); if (inp === ui.optFeather) rebuildMesh(); redrawStill(); });
}
for (const c of [ui.optMouth, ui.optEyes]) c.addEventListener('change', () => { rebuildMesh(); redrawStill(); });
for (const c of [ui.optColor, ui.optLabel, ui.optFaces]) c.addEventListener('change', () => { S.gains = []; redrawStill(); });
ui.optRes.addEventListener('change', () => {
  if (S.tgtType === 'image') sizeCanvas(ui.tgtImg.naturalWidth, ui.tgtImg.naturalHeight);
  else if (S.tgtType === 'video') sizeCanvas(ui.vid.videoWidth, ui.vid.videoHeight);
  redrawStill();
});

/* ---------------- Saving (desktop download / Android bridge) ---------------- */
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

async function saveBlob(blob, name) {
  const bridge = window.AndroidBridge;
  if (bridge) {
    setStatus(ui.tgtStatus, 'Saving…');
    const id = bridge.begin(name, blob.type || 'application/octet-stream');
    if (id < 0) { setStatus(ui.tgtStatus, 'Could not create file', 'bad'); return; }
    const CH = 3 * 262144; // multiple of 3 so each base64 piece stands alone
    for (let off = 0; off < blob.size; off += CH) {
      const b64 = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(String(fr.result).split(',')[1] || '');
        fr.readAsDataURL(blob.slice(off, off + CH));
      });
      if (!bridge.append(id, b64)) { setStatus(ui.tgtStatus, 'Write failed', 'bad'); return; }
      ui.prog.style.width = (100 * off / blob.size).toFixed(0) + '%';
    }
    const where = bridge.finish(id);
    setStatus(ui.tgtStatus, 'Saved to ' + where, 'ok');
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  setStatus(ui.tgtStatus, 'Saved ' + name, 'ok');
}

initEngine();
