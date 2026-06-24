import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------------------------------------------------------------
   Agentes — constelação viva dos agentes OpenClaw.
   Cada agente é um personagem 3D low-poly orbitando o núcleo.
----------------------------------------------------------------*/

const PALETTE = {
  main:       0x7c9bff,
  almeida:    0xffcf6b,
  devinho:    0x46e6b0,
  carteiro:   0xc58bff,
  suportekap: 0xff8fa3,
};
const FALLBACK = [0x7c9bff, 0x46e6b0, 0xffcf6b, 0xc58bff, 0xff8fa3, 0x6be4ff];
const hex = n => '#' + n.toString(16).padStart(6, '0');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let agents = [], nodes = [], selected = null, activityTimer = null;
const threads = {};
let prevBusy = {}; // para detectar mudança de estado

// ================================================================
//  SOUND ENGINE (Web Audio API — sem arquivos externos)
// ================================================================
let _ac = null;
function getAC() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}
function tone(freq, type, dur, vol = 0.18, freqEnd = null) {
  try {
    const ac = getAC();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = type;
    o.frequency.setValueAtTime(freq, ac.currentTime);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, ac.currentTime + dur * 0.75);
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.start(); o.stop(ac.currentTime + dur);
  } catch (_) {}
}
const sfx = {
  select:  () => { tone(440, 'sine', 0.18, 0.22, 880); setTimeout(() => tone(880, 'sine', 0.26, 0.1), 130); },
  send:    () => tone(680, 'triangle', 0.14, 0.14, 1360),
  message: () => { tone(660, 'sine', 0.2, 0.13); setTimeout(() => tone(990, 'sine', 0.22, 0.09), 110); },
  busy:    () => { tone(320, 'sine', 0.15, 0.07, 420); setTimeout(() => tone(520, 'sine', 0.2, 0.06), 120); },
  login:   () => { [440, 550, 660].forEach((f, i) => setTimeout(() => tone(f, 'sine', 0.2, 0.12), i * 90)); },
};

// ================================================================
//  THREE.JS SETUP
// ================================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05060f, 0.018);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 4.5, 17);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 8;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI * 0.85;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.45;

scene.add(new THREE.AmbientLight(0x404a7a, 1.5));
const key = new THREE.PointLight(0x9ab0ff, 140, 70); key.position.set(0, 8, 6); scene.add(key);
const fill = new THREE.PointLight(0x46e6b0, 40, 50); fill.position.set(-8, -4, -4); scene.add(fill);

// starfield
(function stars() {
  const N = 1400, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 40 + Math.random() * 90;
    const t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
    pos[i*3]   = r * Math.sin(p) * Math.cos(t);
    pos[i*3+1] = r * Math.cos(p) * 0.6;
    pos[i*3+2] = r * Math.sin(p) * Math.sin(t);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8ea0ff, size: 0.18, transparent: true, opacity: 0.7, depthWrite: false })));
})();

// núcleo central
const core = new THREE.Group();
const coreInner = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.25, 1),
  new THREE.MeshStandardMaterial({ color: 0x101030, emissive: 0x4a63d6, emissiveIntensity: 1.4, metalness: 0.4, roughness: 0.2, flatShading: true })
);
const coreWire = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.7, 1),
  new THREE.MeshBasicMaterial({ color: 0x9ab0ff, wireframe: true, transparent: true, opacity: 0.22 })
);
core.add(coreInner, coreWire);
scene.add(core);

// ================================================================
//  CHARACTER BUILDER — low-poly robot 3D
// ================================================================
function buildCharacter(color, variant) {
  const g = new THREE.Group();

  function m(geo, mat) { return new THREE.Mesh(geo, mat); }
  const cMat = () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.7, flatShading: true });
  const dMat = () => new THREE.MeshStandardMaterial({ color: 0x0c1020, roughness: 0.8, metalness: 0.3, flatShading: true });
  const glMat = () => new THREE.MeshBasicMaterial({ color });

  function add(geo, mat, px, py, pz, rx, ry, rz) {
    const mesh = m(geo, mat);
    mesh.position.set(px ?? 0, py ?? 0, pz ?? 0);
    if (rx) mesh.rotation.x = rx;
    if (ry) mesh.rotation.y = ry;
    if (rz) mesh.rotation.z = rz;
    g.add(mesh);
    return mesh;
  }

  // head
  const head  = add(new THREE.BoxGeometry(0.62, 0.56, 0.52), cMat(), 0, 1.08, 0);
               add(new THREE.BoxGeometry(0.44, 0.19, 0.06), dMat(), 0, 1.10, 0.27); // visor
  const eyeL  = add(new THREE.BoxGeometry(0.10, 0.08, 0.05), glMat(),  0.11, 1.11, 0.30);
  const eyeR  = add(new THREE.BoxGeometry(0.10, 0.08, 0.05), glMat(), -0.11, 1.11, 0.30);

  // torso
  const torso = add(new THREE.BoxGeometry(0.80, 0.70, 0.50), cMat(), 0, 0.34, 0);
               add(new THREE.BoxGeometry(0.40, 0.34, 0.07), dMat(), 0, 0.40, 0.265); // chest panel

  // arms
  const armL  = add(new THREE.CylinderGeometry(0.11, 0.10, 0.62, 6), cMat(),  0.56, 0.30, 0, 0, 0,  0.18);
  const armR  = add(new THREE.CylinderGeometry(0.11, 0.10, 0.62, 6), cMat(), -0.56, 0.30, 0, 0, 0, -0.18);
               add(new THREE.SphereGeometry(0.12, 6, 4), cMat(),  0.70, -0.05, 0); // hand L
               add(new THREE.SphereGeometry(0.12, 6, 4), cMat(), -0.70, -0.05, 0); // hand R

  // hips + legs + feet
               add(new THREE.BoxGeometry(0.66, 0.18, 0.46), cMat(), 0, 0, 0);
  const legL  = add(new THREE.CylinderGeometry(0.13, 0.11, 0.64, 6), cMat(),  0.21, -0.44, 0);
  const legR  = add(new THREE.CylinderGeometry(0.13, 0.11, 0.64, 6), cMat(), -0.21, -0.44, 0);
               add(new THREE.BoxGeometry(0.20, 0.12, 0.30), cMat(),  0.21, -0.78, 0.04);
               add(new THREE.BoxGeometry(0.20, 0.12, 0.30), cMat(), -0.21, -0.78, 0.04);

  // variant accessories
  const v = (variant ?? 0) % 5;
  if (v === 0) { // antenna
    add(new THREE.CylinderGeometry(0.024, 0.024, 0.38, 5), cMat(), 0.14, 1.54, 0);
    add(new THREE.SphereGeometry(0.065, 7, 5), glMat(), 0.14, 1.75, 0);
  } else if (v === 1) { // monocle
    add(new THREE.TorusGeometry(0.10, 0.022, 6, 12), glMat(), 0.13, 1.11, 0.28);
  } else if (v === 2) { // dual antennas
    [-0.17, 0.17].forEach(x => {
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.33, 5), cMat(), x, 1.50, 0);
      add(new THREE.SphereGeometry(0.052, 6, 4), glMat(), x, 1.67, 0);
    });
  } else if (v === 3) { // flat hat
    add(new THREE.CylinderGeometry(0.40, 0.33, 0.16, 8), dMat(), 0, 1.43, 0);
  } else { // headset
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.038, 6, 14, Math.PI), dMat());
    arc.rotation.z = Math.PI / 2; arc.position.set(0, 1.27, 0); g.add(arc);
    add(new THREE.BoxGeometry(0.07, 0.11, 0.06), dMat(), -0.37, 1.0, 0.18);
  }

  g.position.y = -0.38;
  g.scale.setScalar(0.78);

  const meshes = [head, torso, armL, armR, legL, legR];
  return { group: g, head, torso, armL, armR, legL, legR, eyeL, eyeR, meshes };
}

// ================================================================
//  LABEL SPRITES
// ================================================================
function makeLabel(text, emoji, colorHex) {
  const c = document.createElement('canvas');
  const W = 512, H = 160; c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.font = '76px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(emoji, W/2, 56);
  ctx.font = '600 38px "Space Grotesk", sans-serif';
  ctx.fillStyle = colorHex;
  ctx.shadowColor = colorHex; ctx.shadowBlur = 18;
  ctx.fillText(text, W/2, 122);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(3.2, 1.0, 1);
  return spr;
}

function makeGlow(color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64,64,0,64,64,64);
  const col = new THREE.Color(color);
  grad.addColorStop(0, `rgba(${col.r*255|0},${col.g*255|0},${col.b*255|0},0.9)`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad; ctx.fillRect(0,0,128,128);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  spr.scale.set(4, 4, 1);
  return spr;
}

function makeStream(color, from) {
  const N = 30, pos = new Float32Array(N * 3), t = new Float32Array(N);
  for (let i = 0; i < N; i++) t[i] = i / N;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size: 0.16, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  return { points: new THREE.Points(geo, mat), t, from: from.clone(), N };
}

// ================================================================
//  BUILD NODES
// ================================================================
function buildNodes() {
  nodes.forEach(n => scene.remove(n.group));
  nodes = [];
  const R = 6.4;
  agents.forEach((a, i) => {
    const color = PALETTE[a.id] ?? FALLBACK[i % FALLBACK.length];
    const ang   = (i / agents.length) * Math.PI * 2;
    const group = new THREE.Group();
    group.position.set(Math.cos(ang) * R, Math.sin(i * 1.7) * 1.3, Math.sin(ang) * R);

    // 3D character
    const char = buildCharacter(color, i);
    char.meshes.forEach(mesh => { mesh.userData.agentId = a.id; });
    group.add(char.group);

    // halo ring
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.045, 16, 80),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
    );
    halo.rotation.x = Math.PI / 2.3 + i;
    group.add(halo);

    // glow sprite
    const glow = makeGlow(color);
    group.add(glow);

    // label
    const label = makeLabel(a.name || a.id, a.emoji || '🤖', hex(color));
    label.position.y = 2.4;
    group.add(label);

    // line to core
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), group.position.clone().negate()]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 }));
    group.add(line);

    // particle stream
    const stream = makeStream(color, group.position);
    group.add(stream.points);

    scene.add(group);
    nodes.push({ id: a.id, group, char, halo, glow, line, stream, color, base: group.position.clone(), phase: i * 1.7, busy: !!a.busy });
  });
  buildDock();
}

// ================================================================
//  RAYCASTER
// ================================================================
const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downXY = null;

canvas.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!downXY) return;
  const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if (moved > 6) return;
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(pointer, camera);
  const hits = ray.intersectObjects(nodes.flatMap(n => n.char.meshes), false);
  if (hits.length) selectAgent(hits[0].object.userData.agentId);
});

canvas.addEventListener('pointermove', e => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(pointer, camera);
  canvas.style.cursor = ray.intersectObjects(nodes.flatMap(n => n.char.meshes), false).length ? 'pointer' : 'grab';
});

// ================================================================
//  ANIMATION LOOP
// ================================================================
let t = 0;
function tick() {
  requestAnimationFrame(tick);
  t += 0.016;

  // core
  core.rotation.y += 0.003; core.rotation.x += 0.0012;
  const cs = 1 + Math.sin(t * 1.5) * 0.06; coreInner.scale.setScalar(cs);
  coreInner.material.emissiveIntensity = 1.2 + Math.sin(t * 2) * 0.35;

  nodes.forEach(n => {
    // idle bob
    n.group.position.y = n.base.y + Math.sin(t + n.phase) * (reduceMotion ? 0 : 0.35);
    n.halo.rotation.z += 0.01 + (n.busy ? 0.03 : 0);

    // glow
    const gscale = n.busy ? 4.6 + Math.sin(t * 6) * 0.6 : 4;
    n.glow.scale.setScalar(gscale + (selected === n.id ? 1.2 : 0));
    n.line.material.opacity = n.busy ? 0.22 + Math.sin(t * 5) * 0.16 : 0.16;

    // character animation
    const speed = n.busy ? 7 : 1.8;
    const amp   = n.busy ? 0.52 : (reduceMotion ? 0 : 0.10);
    const swing = Math.sin(t * speed + n.phase) * amp;
    n.char.armL.rotation.x =  swing;
    n.char.armR.rotation.x = -swing;
    n.char.legL.rotation.x = -swing * 0.7;
    n.char.legR.rotation.x =  swing * 0.7;

    // head bob
    n.char.head.rotation.y = Math.sin(t * 1.4 + n.phase) * (reduceMotion ? 0 : 0.12);

    // eye blink (~every 4s)
    const bt = (t + n.phase * 3) % 4;
    const blink = bt < 0.08 ? bt / 0.08 : bt < 0.18 ? 1 - (bt - 0.08) / 0.1 : 0;
    n.char.eyeL.scale.y = n.char.eyeR.scale.y = Math.max(0.05, 1 - blink * 0.95);

    // emissive pulse
    const pulse = n.busy ? 0.45 + Math.sin(t * 6) * 0.3 : 0.35;
    n.char.torso.material.emissiveIntensity = pulse;
    n.char.head.material.emissiveIntensity  = pulse;

    // particle stream
    const sm = n.stream.points.material;
    sm.opacity += ((n.busy ? 0.85 : 0) - sm.opacity) * 0.08;
    if (sm.opacity > 0.02) {
      const arr = n.stream.points.geometry.attributes.position.array;
      for (let k = 0; k < n.stream.N; k++) {
        n.stream.t[k] += 0.012;
        if (n.stream.t[k] > 1) n.stream.t[k] -= 1;
        const tt = n.stream.t[k];
        arr[k*3]   = -n.base.x * tt + Math.sin(tt * 9 + k) * 0.12;
        arr[k*3+1] = -n.base.y * tt;
        arr[k*3+2] = -n.base.z * tt + Math.cos(tt * 9 + k) * 0.12;
      }
      n.stream.points.geometry.attributes.position.needsUpdate = true;
    }
  });

  controls.update();
  renderer.render(scene, camera);
}
tick();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ================================================================
//  UI / API
// ================================================================
const $ = s => document.querySelector(s);
const panel = $('#panel'), dock = $('#dock');

async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  if (r.status === 401) { showLogin(); throw new Error('auth_required'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---- login ----
function showLogin() {
  $('#loginOverlay').classList.add('visible');
}
function hideLogin() {
  $('#loginOverlay').classList.remove('visible');
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#loginBtn'), err = $('#loginErr');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#loginEmail').value.trim(), pass: $('#loginPass').value }),
    });
    const d = await r.json();
    if (d.ok) {
      sfx.login();
      hideLogin();
      loadAgents();
    } else {
      err.textContent = d.error || 'Credenciais inválidas.';
    }
  } catch (_) {
    err.textContent = 'Erro de conexão.';
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
});

// ---- agentes ----
async function loadAgents() {
  try {
    agents = await api('/agents');
    buildNodes();
    setGateway(true);
  } catch (e) {
    if (e.message !== 'auth_required') setGateway(false);
    console.error(e);
  }
}

function setGateway(online) {
  const el = $('#gwStatus');
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  el.querySelector('.label').textContent = online ? 'gateway online' : 'gateway offline';
}

function buildDock() {
  dock.innerHTML = '';
  agents.forEach((a, i) => {
    const color = PALETTE[a.id] ?? FALLBACK[i % FALLBACK.length];
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.setProperty('--c', hex(color));
    chip.dataset.id = a.id;
    chip.innerHTML = `<span class="ico">${a.emoji || '🤖'}</span><span class="nm">${a.name || a.id}</span><span class="bdot ${a.busy ? 'busy' : ''}"></span>`;
    chip.onclick = () => selectAgent(a.id);
    dock.appendChild(chip);
  });
}

function focusCamera(node) {
  const target = node.base.clone();
  controls.autoRotate = false;
  const dir = target.clone().normalize();
  const want = target.clone().add(dir.multiplyScalar(7)).setY(target.y + 2.5);
  const start = camera.position.clone(); let p = 0;
  (function fly() {
    p = Math.min(1, p + 0.04);
    const e = 1 - Math.pow(1 - p, 3);
    camera.position.lerpVectors(start, want, e);
    controls.target.lerp(target, e);
    if (p < 1) requestAnimationFrame(fly);
  })();
}

function selectAgent(id) {
  sfx.select();
  selected = id;
  const a = agents.find(x => x.id === id);
  if (!a) return;
  const i = agents.indexOf(a);
  const color = PALETTE[id] ?? FALLBACK[i % FALLBACK.length];
  const node  = nodes.find(n => n.id === id);
  if (node) focusCamera(node);

  $('#hint').classList.add('hidden');
  panel.style.setProperty('--c', hex(color));
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  $('#pAvatar').textContent = a.emoji || '🤖';
  $('#pName').textContent   = a.name  || id;
  $('#pModel').textContent  = a.model || '—';
  setPanelStatus(a.busy);

  dock.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  renderThread(id);
  switchTab('chat');
  startActivityPolling(id);
  $('#msg').focus();
}

function setPanelStatus(busy) {
  const s = $('#pStatus');
  s.classList.toggle('busy', !!busy);
  s.querySelector('.t').textContent = busy ? 'trabalhando agora' : 'ocioso';
}

// tabs
document.querySelectorAll('.tab').forEach(tab => { tab.onclick = () => switchTab(tab.dataset.tab); });
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('is-active', p.dataset.pane === name));
}

// fechar painel
$('#panelClose').onclick = () => {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  selected = null;
  controls.autoRotate = !reduceMotion;
  dock.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  stopActivityPolling();
};

// conversa
function renderThread(id) {
  const thread = $('#thread');
  const hist = threads[id] || [];
  thread.innerHTML = hist.length ? '' : '<div class="placeholder" id="threadPlaceholder">Comece a conversa abaixo.</div>';
  hist.forEach(msg => thread.appendChild(bubble(msg.role, msg.text)));
  thread.scrollTop = thread.scrollHeight;
}
function bubble(role, text) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (role === 'me' ? 'me' : role === 'err' ? 'err' : 'them');
  d.textContent = text;
  return d;
}

$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const id = selected; if (!id) return;
  const input = $('#msg');
  const text  = input.value.trim(); if (!text) return;
  input.value = '';
  const thread = $('#thread');
  const ph = $('#threadPlaceholder'); if (ph) ph.remove();

  sfx.send();
  (threads[id] ||= []).push({ role: 'me', text });
  thread.appendChild(bubble('me', text));

  const typing = document.createElement('div');
  typing.className = 'typing'; typing.innerHTML = '<i></i><i></i><i></i>';
  thread.appendChild(typing);
  thread.scrollTop = thread.scrollHeight;

  const sendBtn = $('#send'); sendBtn.disabled = true;
  setPanelStatus(true);
  try {
    const res = await api('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: id, message: text }),
    });
    typing.remove();
    if (res.reply) {
      sfx.message();
      threads[id].push({ role: 'them', text: res.reply });
      thread.appendChild(bubble('them', res.reply));
    } else {
      const msg = res.error ? 'Falha: ' + res.error : 'O agente não respondeu.';
      thread.appendChild(bubble('err', msg));
    }
  } catch (err) {
    if (err.message !== 'auth_required') {
      typing.remove();
      thread.appendChild(bubble('err', 'Erro de conexão com o agente.'));
    }
  } finally {
    sendBtn.disabled = false;
    thread.scrollTop = thread.scrollHeight;
    refreshActivity(id);
  }
});

// atividade
function startActivityPolling(id) {
  stopActivityPolling();
  refreshActivity(id);
  activityTimer = setInterval(() => refreshActivity(id), 5000);
}
function stopActivityPolling() {
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
}

let lastMsgCount = {};
async function refreshActivity(id) {
  if (selected !== id) return;
  try {
    const data = await api('/activity?agent=' + encodeURIComponent(id));
    // som quando agente fica busy
    const wasBusy = prevBusy[id];
    if (data.busy && !wasBusy) sfx.busy();
    prevBusy[id] = data.busy;

    setPanelStatus(data.busy);
    const node = nodes.find(n => n.id === id); if (node) node.busy = data.busy;
    const chip = dock.querySelector(`.chip[data-id="${id}"] .bdot`); if (chip) chip.classList.toggle('busy', data.busy);

    const feed = $('#feed');
    if (!data.messages?.length) { feed.innerHTML = '<div class="placeholder">Sem atividade recente.</div>'; return; }

    // som de nova mensagem do agente
    const newCount = data.messages.length;
    if ((lastMsgCount[id] ?? 0) > 0 && newCount > lastMsgCount[id]) sfx.message();
    lastMsgCount[id] = newCount;

    feed.innerHTML = '';
    data.messages.forEach(msg => {
      const ev = document.createElement('div');
      ev.className = 'ev ' + (msg.role === 'user' ? 'user' : 'assistant');
      const when = msg.ts ? new Date(msg.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      ev.innerHTML = `<div class="who"><span>${msg.role === 'user' ? 'entrada' : 'agente'}</span><span>${when}</span></div><div class="txt"></div>`;
      ev.querySelector('.txt').textContent = msg.text;
      feed.appendChild(ev);
    });
    feed.scrollTop = feed.scrollHeight;
  } catch (_) {}
}

// polling global de estados busy
setInterval(async () => {
  try {
    const list = await api('/agents');
    list.forEach(a => {
      const node = nodes.find(n => n.id === a.id); if (node) node.busy = a.busy;
      const chip = dock.querySelector(`.chip[data-id="${a.id}"] .bdot`); if (chip) chip.classList.toggle('busy', a.busy);
    });
  } catch (_) {}
}, 12000);

loadAgents();
