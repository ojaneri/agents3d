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
const hex = n => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let agents = [], nodes = [], selected = null, activityTimer = null;
let prevBusy = {};                 // para detectar mudança de estado
const queues = {};                 // fila de mensagens por agente
const sending = {};                // se há um envio em andamento por agente
const msgCounts = {};              // respostas (assistant) por agente, do backend
const seen = JSON.parse(localStorage.getItem('agentes_seen') || '{}');   // lidas por agente
const ttsOn = JSON.parse(localStorage.getItem('agentes_tts') || '{}');   // leitura em voz alta por agente

// resolve cor do agente: override de design > paleta fixa > fallback por índice
function parseHex(c) {
  if (!c) return null;
  c = c.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const n = parseInt(c, 16);
  return Number.isNaN(n) ? null : n;
}
function agentColor(a, i) {
  return parseHex(a.color) ?? PALETTE[a.id] ?? FALLBACK[i % FALLBACK.length];
}
function agentCharId(a) { return a.character || 'robot'; }
// respostas não lidas = respostas na sessão menos as já vistas
function unreadOf(id) { return Math.max(0, (msgCounts[id] ?? 0) - (seen[id] ?? 0)); }
const nowSec = () => Date.now() / 1000;
// ancora o fim do rate-limit no relógio do cliente (backend manda só os segundos restantes)
function anchorRate(a) { a.rateLimitedUntil = a.rateLimited ? nowSec() + (a.rateRemaining || 0) : 0; }

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
//  CHARACTER BUILDERS — vários modelos 3D low-poly
//  Cada builder devolve { group, meshes, update?, head?, torso?,
//  armL?, armR?, legL?, legR?, eyeL?, eyeR? } — partes opcionais.
// ================================================================
function mats(color) {
  return {
    c:  () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.7, flatShading: true }),
    d:  () => new THREE.MeshStandardMaterial({ color: 0x0c1020, roughness: 0.8, metalness: 0.3, flatShading: true }),
    gl: () => new THREE.MeshBasicMaterial({ color }),
  };
}
function adder(g) {
  return (geo, mat, px, py, pz, rx, ry, rz) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px ?? 0, py ?? 0, pz ?? 0);
    if (rx) mesh.rotation.x = rx;
    if (ry) mesh.rotation.y = ry;
    if (rz) mesh.rotation.z = rz;
    g.add(mesh);
    return mesh;
  };
}

// — Robô (humanóide clássico) —
function buildRobot(color) {
  const g = new THREE.Group(), M = mats(color), add = adder(g);
  const head  = add(new THREE.BoxGeometry(0.62, 0.56, 0.52), M.c(), 0, 1.08, 0);
               add(new THREE.BoxGeometry(0.44, 0.19, 0.06), M.d(), 0, 1.10, 0.27);
  const eyeL  = add(new THREE.BoxGeometry(0.10, 0.08, 0.05), M.gl(),  0.11, 1.11, 0.30);
  const eyeR  = add(new THREE.BoxGeometry(0.10, 0.08, 0.05), M.gl(), -0.11, 1.11, 0.30);
  const torso = add(new THREE.BoxGeometry(0.80, 0.70, 0.50), M.c(), 0, 0.34, 0);
               add(new THREE.BoxGeometry(0.40, 0.34, 0.07), M.d(), 0, 0.40, 0.265);
  const armL  = add(new THREE.CylinderGeometry(0.11, 0.10, 0.62, 6), M.c(),  0.56, 0.30, 0, 0, 0,  0.18);
  const armR  = add(new THREE.CylinderGeometry(0.11, 0.10, 0.62, 6), M.c(), -0.56, 0.30, 0, 0, 0, -0.18);
               add(new THREE.SphereGeometry(0.12, 6, 4), M.c(),  0.70, -0.05, 0);
               add(new THREE.SphereGeometry(0.12, 6, 4), M.c(), -0.70, -0.05, 0);
               add(new THREE.BoxGeometry(0.66, 0.18, 0.46), M.c(), 0, 0, 0);
  const legL  = add(new THREE.CylinderGeometry(0.13, 0.11, 0.64, 6), M.c(),  0.21, -0.44, 0);
  const legR  = add(new THREE.CylinderGeometry(0.13, 0.11, 0.64, 6), M.c(), -0.21, -0.44, 0);
               add(new THREE.BoxGeometry(0.20, 0.12, 0.30), M.c(),  0.21, -0.78, 0.04);
               add(new THREE.BoxGeometry(0.20, 0.12, 0.30), M.c(), -0.21, -0.78, 0.04);
  add(new THREE.CylinderGeometry(0.024, 0.024, 0.38, 5), M.c(), 0.14, 1.54, 0);
  add(new THREE.SphereGeometry(0.065, 7, 5), M.gl(), 0.14, 1.75, 0);
  g.position.y = -0.38; g.scale.setScalar(0.78);
  return { group: g, head, torso, armL, armR, legL, legR, eyeL, eyeR, meshes: [head, torso, armL, armR, legL, legR] };
}

// — Andróide (esguio, cabeça arredondada, visor faixa) —
function buildAndroid(color) {
  const g = new THREE.Group(), M = mats(color), add = adder(g);
  const head  = add(new THREE.SphereGeometry(0.34, 12, 10), M.c(), 0, 1.12, 0);
               add(new THREE.TorusGeometry(0.30, 0.05, 8, 18), M.d(), 0, 1.12, 0.04, Math.PI / 2);
  const eyeL  = add(new THREE.BoxGeometry(0.16, 0.05, 0.04), M.gl(), 0, 1.13, 0.31);
  const eyeR  = eyeL;
  const torso = add(new THREE.CylinderGeometry(0.30, 0.36, 0.86, 10), M.c(), 0, 0.40, 0);
               add(new THREE.SphereGeometry(0.10, 10, 8), M.gl(), 0, 0.52, 0.30);
  const armL  = add(new THREE.CapsuleGeometry(0.07, 0.5, 3, 6), M.c(),  0.42, 0.40, 0, 0, 0,  0.12);
  const armR  = add(new THREE.CapsuleGeometry(0.07, 0.5, 3, 6), M.c(), -0.42, 0.40, 0, 0, 0, -0.12);
  const legL  = add(new THREE.CapsuleGeometry(0.09, 0.5, 3, 6), M.c(),  0.16, -0.32, 0);
  const legR  = add(new THREE.CapsuleGeometry(0.09, 0.5, 3, 6), M.c(), -0.16, -0.32, 0);
  g.position.y = -0.30; g.scale.setScalar(0.82);
  return { group: g, head, torso, armL, armR, legL, legR, eyeL, eyeR, meshes: [head, torso, armL, armR, legL, legR] };
}

// — Drone (corpo flutuante + 4 rotores) —
function buildDrone(color) {
  const g = new THREE.Group(), M = mats(color), add = adder(g);
  const torso = add(new THREE.OctahedronGeometry(0.5, 0), M.c(), 0, 0.4, 0);
  const head  = add(new THREE.SphereGeometry(0.18, 12, 10), M.gl(), 0, 0.4, 0.42);
               add(new THREE.TorusGeometry(0.2, 0.05, 8, 16), M.d(), 0, 0.4, 0.42, Math.PI / 2);
  const rotors = [];
  [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]].forEach(([x, z]) => {
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 5), M.d(), x * 0.6, 0.4, z * 0.6, 0, 0, x > 0 ? -0.5 : 0.5);
    const r = add(new THREE.BoxGeometry(0.5, 0.03, 0.08), M.c(), x, 0.62, z);
    rotors.push(r);
  });
  g.position.y = 0; g.scale.setScalar(0.9);
  return {
    group: g, head, torso, eyeL: head, eyeR: head, meshes: [torso, head, ...rotors],
    update(t) { rotors.forEach((r, i) => { r.rotation.y += 0.6 + i * 0.05; }); },
  };
}

// — Orbe (núcleo + anéis orbitando) —
function buildOrb(color) {
  const g = new THREE.Group(), M = mats(color), add = adder(g);
  const torso = add(new THREE.IcosahedronGeometry(0.5, 1), M.c(), 0, 0.4, 0);
  const head  = add(new THREE.SphereGeometry(0.52, 16, 12),
                    new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 }), 0, 0.4, 0);
  const ring1 = add(new THREE.TorusGeometry(0.78, 0.03, 8, 40), M.gl(), 0, 0.4, 0, Math.PI / 2.2);
  const ring2 = add(new THREE.TorusGeometry(0.95, 0.025, 8, 44), M.gl(), 0, 0.4, 0, Math.PI / 1.7, 0.6);
  g.position.y = 0; g.scale.setScalar(0.95);
  return {
    group: g, head: torso, torso, eyeL: torso, eyeR: torso, meshes: [torso, head],
    update(t) { ring1.rotation.z += 0.012; ring1.rotation.x += 0.008; ring2.rotation.z -= 0.016; ring2.rotation.y += 0.01; },
  };
}

// — Tanque (robusto, base com esteiras) —
function buildTank(color) {
  const g = new THREE.Group(), M = mats(color), add = adder(g);
  const head  = add(new THREE.BoxGeometry(0.72, 0.5, 0.6), M.c(), 0, 1.0, 0);
               add(new THREE.BoxGeometry(0.56, 0.16, 0.06), M.d(), 0, 1.02, 0.31);
  const eyeL  = add(new THREE.BoxGeometry(0.12, 0.09, 0.05), M.gl(),  0.14, 1.03, 0.32);
  const eyeR  = add(new THREE.BoxGeometry(0.12, 0.09, 0.05), M.gl(), -0.14, 1.03, 0.32);
  const torso = add(new THREE.BoxGeometry(1.0, 0.6, 0.7), M.c(), 0, 0.45, 0);
  const armL  = add(new THREE.BoxGeometry(0.18, 0.5, 0.22), M.c(),  0.62, 0.45, 0, 0, 0, 0.1);
  const armR  = add(new THREE.BoxGeometry(0.18, 0.5, 0.22), M.c(), -0.62, 0.45, 0, 0, 0, -0.1);
               add(new THREE.BoxGeometry(1.15, 0.32, 0.85), M.d(), 0, 0.02, 0);
  const legL  = add(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 10), M.c(),  0.5, -0.05, 0, Math.PI / 2);
  const legR  = add(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 10), M.c(), -0.5, -0.05, 0, Math.PI / 2);
  g.position.y = -0.15; g.scale.setScalar(0.74);
  return { group: g, head, torso, armL, armR, legL, legR, eyeL, eyeR, meshes: [head, torso, armL, armR, legL, legR] };
}

const CHARACTERS = [
  { id: 'robot',   label: 'Robô',     emoji: '🤖', build: buildRobot },
  { id: 'android', label: 'Andróide', emoji: '🦾', build: buildAndroid },
  { id: 'drone',   label: 'Drone',    emoji: '🛸', build: buildDrone },
  { id: 'orb',     label: 'Orbe',     emoji: '🔮', build: buildOrb },
  { id: 'tank',    label: 'Tanque',   emoji: '🛡️', build: buildTank },
];
function buildCharacter(charId, color) {
  const def = CHARACTERS.find(c => c.id === charId) || CHARACTERS[0];
  return def.build(color);
}

// ================================================================
//  SPRITES (rótulos, glow, badges, balão de não lidas)
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
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
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

// plaquinha de estado: texto + cor de destaque
function paintBadge(sprite, txt, accent, dim) {
  const c = document.createElement('canvas'); c.width = 340; c.height = 90;
  const ctx = c.getContext('2d');
  ctx.fillStyle = dim ? 'rgba(14,18,38,.62)' : 'rgba(14,18,38,.92)';
  roundRect(ctx, 8, 22, 324, 46, 23); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = accent; ctx.stroke();
  ctx.font = '600 30px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = dim ? '#9aa3c7' : '#eef1ff';
  ctx.fillText(txt, 170, 46);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  sprite.material.map?.dispose();
  sprite.material.map = tex; sprite.material.needsUpdate = true;
}
// tempo restante m:ss
function fmtCountdown(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
// estado textual de um nó (rate-limited > ocupado > ocioso)
function nodeBadge(n) {
  if (n.rateLimited) return { text: '💤 ' + fmtCountdown((n.rateUntil || 0) - Date.now() / 1000), accent: '#ffcf6b', dim: false };
  if (n.busy)        return { text: '▶ trabalhando', accent: hex(n.color), dim: false };
  return { text: '⏸ ocioso', accent: '#7e87ad', dim: true };
}
function makeBadge() {
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
  spr.scale.set(2.3, 0.65, 1);
  return spr;
}

// balão de respostas não lidas
function paintBubble(sprite, count) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff5a6e';
  roundRect(ctx, 16, 12, 96, 76, 24); ctx.fill();
  ctx.beginPath(); ctx.moveTo(48, 84); ctx.lineTo(64, 110); ctx.lineTo(76, 84); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 56px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), 64, 48);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  sprite.material.map?.dispose();
  sprite.material.map = tex; sprite.material.needsUpdate = true;
}
function makeBubble() {
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
  spr.scale.set(0.95, 0.95, 1); spr.visible = false;
  return spr;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
// libera geometrias/materiais/texturas de um grupo antes de descartá-lo (evita leak de GPU)
function disposeGroup(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach(m => { m.map?.dispose(); m.dispose(); });
  });
}

function buildNodes() {
  nodes.forEach(n => { disposeGroup(n.group); scene.remove(n.group); });
  nodes = [];
  const R = 6.4;
  agents.forEach((a, i) => {
    const color = agentColor(a, i);
    const ang   = (i / agents.length) * Math.PI * 2;
    const group = new THREE.Group();
    group.position.set(Math.cos(ang) * R, Math.sin(i * 1.7) * 1.3, Math.sin(ang) * R);

    const char = buildCharacter(agentCharId(a), color);
    char.meshes.forEach(mesh => { mesh.userData.agentId = a.id; });
    group.add(char.group);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.045, 16, 80),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
    );
    halo.rotation.x = Math.PI / 2.3 + i;
    group.add(halo);

    // arco-spinner: aparece girando quando ocupado
    const haloArc = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.07, 12, 48, Math.PI * 0.5),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
    );
    haloArc.rotation.x = Math.PI / 2.3 + i;
    group.add(haloArc);

    const glow = makeGlow(color);
    group.add(glow);

    const label = makeLabel(a.name || a.id, a.emoji || '🤖', hex(color));
    label.position.y = 2.35;
    group.add(label);

    const badge = makeBadge();
    badge.position.y = 1.82;
    group.add(badge);

    const bubble = makeBubble();
    bubble.position.set(0.95, 2.95, 0);
    group.add(bubble);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), group.position.clone().negate()]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 }));
    group.add(line);

    const stream = makeStream(color, group.position);
    group.add(stream.points);

    scene.add(group);
    const node = { id: a.id, group, char, halo, haloArc, glow, line, stream, badge, bubble, color,
                   base: group.position.clone(), phase: i * 1.7, busy: !!a.busy, unread: 0,
                   rateLimited: !!a.rateLimited, rateUntil: a.rateLimitedUntil || 0, badgeText: null };
    const b0 = nodeBadge(node);
    paintBadge(badge, b0.text, b0.accent, b0.dim);
    node.badgeText = b0.text;
    nodes.push(node);
  });
  buildDock();
  updateUnreadBadges();
  renderCards();
  if (selected) markActiveChip(selected);
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

  core.rotation.y += 0.003; core.rotation.x += 0.0012;
  const cs = 1 + Math.sin(t * 1.5) * 0.06; coreInner.scale.setScalar(cs);
  coreInner.material.emissiveIntensity = 1.2 + Math.sin(t * 2) * 0.35;

  nodes.forEach(n => {
    // rate-limited: dormindo (tombado, respirando devagar, olhos fechados)
    if (n.rateLimited) {
      n.char.group.rotation.z = 0.6;
      n.group.position.y = n.base.y - 0.2 + Math.sin(t * 1.1 + n.phase) * 0.05;
      n.halo.material.opacity = 0.1; n.haloArc.material.opacity = 0; n.glow.material.opacity = 0.3;
      if (n.char.eyeL) { n.char.eyeL.scale.y = 0.1; if (n.char.eyeR && n.char.eyeR !== n.char.eyeL) n.char.eyeR.scale.y = 0.1; }
      if (n.char.armL) n.char.armL.rotation.x = 0;
      if (n.char.armR) n.char.armR.rotation.x = 0;
      return;
    }
    n.char.group.rotation.z = 0;
    const busy = n.busy;
    n.group.position.y = n.base.y + Math.sin(t + n.phase) * (reduceMotion ? 0 : (busy ? 0.35 : 0.22));

    // halo + arco-spinner
    n.halo.rotation.z += busy ? 0.04 : 0.006;
    n.halo.material.opacity = busy ? 0.6 : 0.28;
    n.haloArc.rotation.z += busy ? 0.16 : 0;
    n.haloArc.material.opacity += ((busy ? 0.95 : 0) - n.haloArc.material.opacity) * 0.12;

    // glow
    const gscale = busy ? 4.6 + Math.sin(t * 6) * 0.6 : 3.4;
    n.glow.scale.setScalar(gscale + (selected === n.id ? 1.2 : 0));
    n.glow.material.opacity = busy ? 1 : 0.6;
    n.line.material.opacity = busy ? 0.22 + Math.sin(t * 5) * 0.16 : 0.12;

    // personagem custom (drone/orbe)
    n.char.update?.(t, busy);

    // membros (se humanóide)
    const speed = busy ? 7 : 1.8;
    const amp   = busy ? 0.52 : (reduceMotion ? 0 : 0.08);
    const swing = Math.sin(t * speed + n.phase) * amp;
    if (n.char.armL) n.char.armL.rotation.x =  swing;
    if (n.char.armR) n.char.armR.rotation.x = -swing;
    if (n.char.legL) n.char.legL.rotation.x = -swing * 0.7;
    if (n.char.legR) n.char.legR.rotation.x =  swing * 0.7;
    if (n.char.head) n.char.head.rotation.y = Math.sin(t * 1.4 + n.phase) * (reduceMotion ? 0 : 0.12);

    // piscar
    if (n.char.eyeL) {
      const bt = (t + n.phase * 3) % 4;
      const blink = bt < 0.08 ? bt / 0.08 : bt < 0.18 ? 1 - (bt - 0.08) / 0.1 : 0;
      const s = Math.max(0.05, 1 - blink * 0.95);
      n.char.eyeL.scale.y = s; if (n.char.eyeR && n.char.eyeR !== n.char.eyeL) n.char.eyeR.scale.y = s;
    }

    // pulso emissivo + dim no ocioso
    const pulse = busy ? 0.5 + Math.sin(t * 6) * 0.3 : 0.18;
    if (n.char.torso?.material) n.char.torso.material.emissiveIntensity = pulse;
    if (n.char.head?.material && 'emissiveIntensity' in n.char.head.material) n.char.head.material.emissiveIntensity = pulse;

    // partículas pro núcleo
    const sm = n.stream.points.material;
    sm.opacity += ((busy ? 0.85 : 0) - sm.opacity) * 0.08;
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

    // balão de não lidas flutuando
    if (n.bubble.visible) n.bubble.position.y = 2.85 + Math.sin(t * 3 + n.phase) * 0.08;
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
  if (!r.ok && r.status !== 207) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---- login ----
function showLogin() { $('#loginOverlay').classList.remove('hidden'); }
function hideLogin() { $('#loginOverlay').classList.add('hidden'); }

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
    if (d.ok) { sfx.login(); hideLogin(); loadAgents(); }
    else err.textContent = d.error || 'Credenciais inválidas.';
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
    agents.forEach(a => { msgCounts[a.id] = a.msgCount ?? 0; anchorRate(a); });
    buildNodes();
    setGateway(true);
    applyHash();
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

// ---- visão em cartões ----
const cardsEl = $('#cards');
let view = localStorage.getItem('agentes_view') || '3d';

function setView(v) {
  view = v;
  localStorage.setItem('agentes_view', v);
  document.body.classList.toggle('cards-mode', v === 'cards');
  cardsEl.classList.toggle('hidden', v !== 'cards');
  controls.autoRotate = (v === '3d' && !selected && !reduceMotion);
  document.querySelectorAll('.vt-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
  if (v === 'cards') renderCards();
}
document.querySelectorAll('.vt-btn').forEach(b => { b.onclick = () => setView(b.dataset.view); });

function renderCards() {
  cardsEl.innerHTML = '';
  agents.forEach((a, i) => {
    const color = hex(agentColor(a, i));
    const card = document.createElement('button');
    card.className = 'agent-card' + (a.rateLimited ? ' sleeping' : a.busy ? ' busy' : '');
    card.style.setProperty('--c', color);
    card.dataset.id = a.id;
    const unread = (selected === a.id) ? 0 : unreadOf(a.id);
    card.innerHTML =
      `<div class="ac-head">
         <div class="ac-ava">${a.emoji || '🤖'}</div>
         <div><p class="ac-name">${a.name || a.id}</p><div class="ac-model">${a.model || '—'}</div></div>
       </div>
       <div class="ac-foot">
         <span class="ac-status"><span class="ac-dot"></span><span class="ac-t">${cardStatusText(a)}</span></span>
         <span class="ac-unread ${unread > 0 ? 'show' : ''}">${unread > 9 ? '9+' : unread}</span>
       </div>`;
    card.onclick = () => selectAgent(a.id);
    cardsEl.appendChild(card);
  });
}

function cardStatusText(a) {
  if (a.rateLimited) return '💤 ' + fmtCountdown((a.rateLimitedUntil || 0) - Date.now() / 1000);
  return a.busy ? 'trabalhando' : 'ocioso';
}
function syncCards() {
  if (view !== 'cards') return;
  agents.forEach(a => {
    const card = cardsEl.querySelector(`.agent-card[data-id="${a.id}"]`);
    if (!card) return;
    card.classList.toggle('busy', !!a.busy && !a.rateLimited);
    card.classList.toggle('sleeping', !!a.rateLimited);
    const tEl = card.querySelector('.ac-t'); if (tEl) tEl.textContent = cardStatusText(a);
    const unread = (selected === a.id) ? 0 : unreadOf(a.id);
    const ub = card.querySelector('.ac-unread');
    if (ub) { ub.textContent = unread > 9 ? '9+' : unread; ub.classList.toggle('show', unread > 0); }
  });
}

function buildDock() {
  dock.innerHTML = '';
  agents.forEach((a, i) => {
    const color = agentColor(a, i);
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.style.setProperty('--c', hex(color));
    chip.dataset.id = a.id;
    chip.innerHTML = `<span class="ico">${a.emoji || '🤖'}</span><span class="nm">${a.name || a.id}</span><span class="bdot ${a.busy ? 'busy' : ''}"></span><span class="ubadge"></span>`;
    chip.onclick = () => selectAgent(a.id);
    dock.appendChild(chip);
  });
}
function markActiveChip(id) {
  dock.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.id === id));
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
  const color = agentColor(a, i);
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

  markActiveChip(id);
  setStageAgent(a, i);            // personagem grande + pet no palco do painel
  applyStageSleepFromAgent(a);
  switchTab('chat');
  renderConversation(id);     // mostra o que já houver em cache; refresh atualiza
  startActivityPolling(id);
  // marca como lidas
  seen[id] = msgCounts[id] ?? 0;
  localStorage.setItem('agentes_seen', JSON.stringify(seen));
  updateUnreadBadges();
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
  if (name === 'design') openDesign();
}

// fechar painel
function closePanel() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  selected = null;
  controls.autoRotate = (view === '3d' && !reduceMotion);
  dock.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  stopActivityPolling();
  stopStageLoop();
}
$('#panelClose').onclick = closePanel;
$('#panelBack').onclick = closePanel;

// ================================================================
//  CONVERSA UNIFICADA (histórico real da sessão) + FILA DE MENSAGENS
//  Fonte da verdade = /api/activity (sessão do agente). As mensagens
//  enviadas aqui entram como "pendentes" até aparecerem na sessão.
// ================================================================
const activityCache = {};   // id -> { messages, busy, ... } da última /api/activity
const pending = {};         // id -> [{ text, status:'sending'|'error' }]

function bubble(role, text) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (role === 'me' ? 'me' : role === 'err' ? 'err' : 'them');
  d.textContent = text;
  return d;
}
// entrada vinda de um canal externo (telegram/cron/…): à esquerda, com tag discreta
function incomingBubble(text, channel) {
  const d = document.createElement('div');
  d.className = 'bubble them incoming';
  const tag = document.createElement('span');
  tag.className = 'ch-tag';
  tag.textContent = '[' + channel + ']';
  d.appendChild(tag);
  d.appendChild(document.createTextNode(text));
  return d;
}

function renderConversation(id) {
  if (selected !== id) return;
  const thread = $('#thread');
  const msgs = activityCache[id]?.messages || [];
  const pend = pending[id] || [];
  if (!msgs.length && !pend.length) {
    thread.innerHTML = '<div class="placeholder">Sem mensagens ainda. Escreva abaixo.</div>';
    return;
  }
  thread.innerHTML = '';
  // canal da sessão: se NÃO for do próprio dashboard, as mensagens "user" são entradas
  // externas (telegram/cron/…) → vão à ESQUERDA com tag discreta, não como "você".
  const ch = activityCache[id]?.channel || null;
  const ownChannel = !ch || ['explicit', 'main', 'web', 'cli'].includes(ch);
  msgs.forEach(m => {
    if (m.role === 'assistant') { thread.appendChild(bubble('them', m.text)); return; }
    if (ownChannel) { thread.appendChild(bubble('me', m.text)); return; }
    thread.appendChild(incomingBubble(m.text, ch));
  });
  pend.forEach(p => {
    if (p.role === 'them') { thread.appendChild(bubble('them', p.text)); return; }
    const b = bubble('me', p.text); b.classList.add('pending'); thread.appendChild(b);
    if (p.status === 'error') thread.appendChild(bubble('err', 'Falha ao enviar — tente de novo.'));
  });
  if (sending[id]) {
    const typing = document.createElement('div');
    typing.className = 'typing'; typing.innerHTML = '<i></i><i></i><i></i>';
    thread.appendChild(typing);
  }
  thread.scrollTop = thread.scrollHeight;
}

$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const id = selected; if (!id) return;
  const input = $('#msg');
  const text  = input.value.trim(); if (!text) return;
  input.value = '';
  enqueueMessage(id, text);
});

function enqueueMessage(id, text) {
  sfx.send();
  (pending[id] ||= []).push({ role: 'me', text, status: 'sending' });
  (queues[id]  ||= []).push(text);
  if (selected === id) { renderConversation(id); updateQueueBadge(id); }
  if (!sending[id]) processQueue(id);
}
// dois textos são "a mesma mensagem" se baterem no início (sessão pode truncar)
function sameMsg(a, b) { return a === b || (a || '').slice(0, 80) === (b || '').slice(0, 80); }

function updateQueueBadge(id) {
  if (selected !== id) return;
  const n = (queues[id]?.length || 0);
  $('#send').textContent = n > 1 ? String(n) : '➤';
}

async function processQueue(id) {
  sending[id] = true;
  if (selected === id) { setPanelStatus(true); $('#send').disabled = true; renderConversation(id); }
  while ((queues[id]?.length || 0) > 0) {
    const text = queues[id].shift();
    updateQueueBadge(id);
    try {
      const res = await api('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: id, message: text }),
      });
      if (res.reply) {
        sfx.message();
        // registra a resposta como balão imediatamente (fica registrada além da voz)
        (pending[id] ||= []).push({ role: 'them', text: res.reply });
        if (selected === id) renderConversation(id);
        maybeSpeak(id, res.reply);
      } else {
        const p = (pending[id] || []).find(x => x.role === 'me' && x.text === text && x.status === 'sending');
        if (p) p.status = 'error';
      }
    } catch (err) {
      if (err.message === 'auth_required') { queues[id] = []; break; }
      const p = (pending[id] || []).find(x => x.role === 'me' && x.text === text && x.status === 'sending');
      if (p) p.status = 'error';
    }
    await refreshActivity(id);   // recarrega da sessão (já contém pergunta + resposta)
  }
  sending[id] = false;
  pollAgents();
  if (selected === id) { $('#send').disabled = false; updateQueueBadge(id); renderConversation(id); }
}

// ================================================================
//  POLLING DA SESSÃO
// ================================================================
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
  try {
    const data = await api('/activity?agent=' + encodeURIComponent(id));
    activityCache[id] = data;
    const wasBusy = prevBusy[id];
    if (data.busy && !wasBusy) sfx.busy();
    prevBusy[id] = data.busy;

    const node = nodes.find(n => n.id === id); if (node) node.busy = data.busy;
    const ag = agents.find(x => x.id === id); if (ag) ag.busy = data.busy;
    const chip = dock.querySelector(`.chip[data-id="${id}"] .bdot`); if (chip) chip.classList.toggle('busy', data.busy);

    // reconcilia pendentes: remove os que já apareceram na sessão (evita duplicar balão)
    if (pending[id]?.length) {
      const userTexts = (data.messages || []).filter(m => m.role === 'user').map(m => m.text);
      const asstTexts = (data.messages || []).filter(m => m.role === 'assistant').map(m => m.text);
      pending[id] = pending[id].filter(p => {
        if (p.role === 'them') return !asstTexts.some(t => sameMsg(t, p.text));
        return p.status === 'error' || !userTexts.some(t => sameMsg(t, p.text));
      });
    }
    // som de nova mensagem
    const newCount = (data.messages || []).length;
    if ((lastMsgCount[id] ?? 0) > 0 && newCount > lastMsgCount[id] && selected === id) sfx.message();
    lastMsgCount[id] = newCount;

    if (selected === id) { setPanelStatus(data.busy); renderConversation(id); }
  } catch (_) {}
}

// polling global: estados busy + contagem para não lidas
async function pollAgents() {
  try {
    const list = await api('/agents');
    list.forEach(a => {
      msgCounts[a.id] = a.msgCount ?? msgCounts[a.id] ?? 0;
      const ag = agents.find(x => x.id === a.id);
      if (ag) { ag.busy = a.busy; ag.msgCount = a.msgCount; ag.rateLimited = a.rateLimited; ag.rateRemaining = a.rateRemaining; anchorRate(ag); }
      const node = nodes.find(n => n.id === a.id);
      if (node) { node.busy = a.busy; node.rateLimited = !!a.rateLimited; node.rateUntil = ag ? ag.rateLimitedUntil : (a.rateLimited ? nowSec() + (a.rateRemaining || 0) : 0); }
      const chip = dock.querySelector(`.chip[data-id="${a.id}"] .bdot`); if (chip) chip.classList.toggle('busy', a.busy);
      if (selected === a.id) { seen[a.id] = msgCounts[a.id]; }
    });
    localStorage.setItem('agentes_seen', JSON.stringify(seen));
    updateUnreadBadges();
    if (selected) { const sa = agents.find(x => x.id === selected); if (sa) applyStageSleepFromAgent(sa); }
  } catch (_) {}
}
setInterval(pollAgents, 12000);

function updateUnreadBadges() {
  nodes.forEach(n => {
    const unread = unreadOf(n.id);
    const wasUnread = n.unread;
    n.unread = (selected === n.id) ? 0 : unread;
    n.bubble.visible = n.unread > 0;
    if (n.unread > 0 && n.unread !== wasUnread) paintBubble(n.bubble, n.unread);
    const ub = dock.querySelector(`.chip[data-id="${n.id}"] .ubadge`);
    if (ub) {
      ub.textContent = n.unread > 9 ? '9+' : String(n.unread);
      ub.classList.toggle('show', n.unread > 0);
    }
  });
  syncCards();
}

// atualiza plaquinha de estado (inclui countdown do rate-limit) quando muda o texto
setInterval(() => {
  nodes.forEach(n => {
    if (n.rateLimited && n.rateUntil && Date.now() / 1000 >= n.rateUntil) n.rateLimited = false;
    const b = nodeBadge(n);
    if (n.badgeText !== b.text) { paintBadge(n.badge, b.text, b.accent, b.dim); n.badgeText = b.text; }
  });
  // contador do palco (foco)
  if (stageSleeping && selected) {
    const a = agents.find(x => x.id === selected);
    const left = (a?.rateLimitedUntil || 0) - Date.now() / 1000;
    if (left <= 0) setStageSleep(false);
    else $('#stageSleepTimer').textContent = fmtCountdown(left);
  }
  // contador nos cards
  if (view === 'cards' && agents.some(a => a.rateLimited)) syncCards();
}, 500);

// ================================================================
//  ABA DESIGN
// ================================================================
let modelsCache = null;
const cur = { color: null };

async function openDesign() {
  const id = selected; if (!id) return;
  const a = agents.find(x => x.id === id); if (!a) return;
  const i = agents.indexOf(a);
  const color = hex(agentColor(a, i));
  cur.color = color;

  // swatches
  const sw = $('#dSwatches'); sw.innerHTML = '';
  FALLBACK.forEach(c => {
    const h = hex(c);
    const b = document.createElement('button');
    b.className = 'd-swatch' + (h === color ? ' sel' : '');
    b.style.setProperty('--sc', h);
    b.onclick = () => setColor(h);
    sw.appendChild(b);
  });
  $('#dColor').value = color;
  $('#dHex').textContent = color;

  // emoji
  $('#dEmoji').value = a.emoji || '';

  // personagens
  const cw = $('#dChars'); cw.innerHTML = '';
  const curChar = agentCharId(a);
  CHARACTERS.forEach(ch => {
    const b = document.createElement('button');
    b.className = 'd-char' + (ch.id === curChar ? ' sel' : '');
    b.dataset.char = ch.id;
    b.innerHTML = `<span class="em">${ch.emoji}</span><span>${ch.label}</span>`;
    b.onclick = () => { cw.querySelectorAll('.d-char').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); };
    cw.appendChild(b);
  });

  // modelos
  const sel = $('#dModel');
  if (!modelsCache) { try { modelsCache = (await api('/models')).models; } catch (_) { modelsCache = []; } }
  sel.innerHTML = '';
  modelsCache.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    if (m.id === a.model) o.selected = true;
    sel.appendChild(o);
  });

  // vozes
  populateVoices(a.voice);
  $('#dTts').checked = !!ttsOn[id];
  $('#dMsg').textContent = ''; $('#dMsg').className = 'd-msg';
}

function setColor(h) {
  cur.color = h;
  $('#dColor').value = h;
  $('#dHex').textContent = h;
  $('#dSwatches').querySelectorAll('.d-swatch').forEach(s =>
    s.classList.toggle('sel', s.style.getPropertyValue('--sc').trim() === h));
}
$('#dColor').addEventListener('input', e => setColor(e.target.value));

function populateVoices(selectedVoice) {
  const sel = $('#dVoice'); if (!sel) return;
  const voices = (window.speechSynthesis?.getVoices() || []);
  const pt = voices.filter(v => /pt/i.test(v.lang));
  const rest = voices.filter(v => !/pt/i.test(v.lang));
  sel.innerHTML = '<option value="">Padrão do sistema</option>';
  [...pt, ...rest].forEach(v => {
    const o = document.createElement('option');
    o.value = v.name; o.textContent = `${v.name} (${v.lang})`;
    if (v.name === selectedVoice) o.selected = true;
    sel.appendChild(o);
  });
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {
  const a = agents.find(x => x.id === selected);
  populateVoices(a?.voice);
};

$('#dVoiceTest').onclick = () => {
  const name = $('#dVoice').value;
  speak('Olá! Sou o agente e esta é a minha voz.', name);
};
$('#dTts').addEventListener('change', e => {
  if (!selected) return;
  ttsOn[selected] = e.target.checked;
  localStorage.setItem('agentes_tts', JSON.stringify(ttsOn));
});

$('#dSave').onclick = async () => {
  const id = selected; if (!id) return;
  const a = agents.find(x => x.id === id); if (!a) return;
  const btn = $('#dSave'), msg = $('#dMsg');
  const payload = {
    agent: id,
    color: cur.color,
    emoji: $('#dEmoji').value.trim(),
    character: $('#dChars').querySelector('.d-char.sel')?.dataset.char || agentCharId(a),
    voice: $('#dVoice').value,
  };
  const newModel = $('#dModel').value;
  if (newModel && newModel !== a.model) payload.model = newModel;

  btn.disabled = true; msg.className = 'd-msg'; msg.textContent = 'Salvando…';
  try {
    const res = await api('/design', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    // aplica localmente
    a.color = payload.color; a.character = payload.character; a.voice = payload.voice;
    if (payload.emoji) a.emoji = payload.emoji;
    if (payload.model) a.model = payload.model;
    buildNodes();
    panel.style.setProperty('--c', payload.color);
    $('#pAvatar').textContent = a.emoji || '🤖';
    $('#pModel').textContent = a.model || '—';
    sfx.select();
    if (res.errors?.length) { msg.className = 'd-msg err'; msg.textContent = '⚠ ' + res.errors.join('; '); }
    else if (res.restartNeeded) { msg.className = 'd-msg ok'; msg.textContent = '✓ Salvo. Modelo alterado — reinicie o gateway p/ valer.'; }
    else { msg.className = 'd-msg ok'; msg.textContent = '✓ Design salvo!'; }
  } catch (err) {
    if (err.message !== 'auth_required') { msg.className = 'd-msg err'; msg.textContent = 'Erro ao salvar.'; }
  } finally {
    btn.disabled = false;
  }
};

// ================================================================
//  VOZ — STT (falar) + TTS (ler em voz alta)
// ================================================================
function speak(text, voiceName) {
  if (!window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    if (voiceName) {
      const v = speechSynthesis.getVoices().find(x => x.name === voiceName);
      if (v) { u.voice = v; u.lang = v.lang; }
    }
    speechSynthesis.speak(u);
  } catch (_) {}
}
function maybeSpeak(id, text) {
  if (!ttsOn[id]) return;
  const a = agents.find(x => x.id === id);
  speak(text, a?.voice);
}

// STT
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('#micBtn');
let recog = null, listening = false;
if (!SR) { if (micBtn) micBtn.style.display = 'none'; }
else if (micBtn) {
  micBtn.onclick = () => {
    if (listening) { recog?.stop(); return; }
    recog = new SR();
    recog.lang = 'pt-BR'; recog.interimResults = true; recog.continuous = false;
    let finalText = '';
    recog.onstart = () => { listening = true; micBtn.classList.add('listening'); };
    recog.onend   = () => {
      listening = false; micBtn.classList.remove('listening');
      const input = $('#msg');
      if (finalText.trim()) { input.value = finalText.trim(); $('#composer').requestSubmit(); }
    };
    recog.onerror = () => { listening = false; micBtn.classList.remove('listening'); };
    recog.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      $('#msg').value = (finalText + interim).trim();
    };
    recog.start();
  };
}

// ================================================================
//  PALCO DO AGENTE (painel) — personagem grande + pet, ações lúdicas
// ================================================================
let stageRenderer = null, stageScene = null, stageCam = null;
let stageChar = null, stageRig = null, stagePet = null, stageRAF = null;
let stageT = 0, stageW = 0, stageH = 0;
let stageZoom = parseFloat(localStorage.getItem('agentes_stagezoom')) || 1;
const STAGE_CAM_Z = 5.4;
function applyStageZoom() {
  if (!stageCam) return;
  stageCam.position.z = STAGE_CAM_Z / stageZoom;
  stageCam.lookAt(0, 0.3, 0);
}
function setStageZoom(z) {
  stageZoom = Math.min(2.5, Math.max(0.5, z));
  localStorage.setItem('agentes_stagezoom', String(stageZoom));
  applyStageZoom();
}
let stageAction = 'idle', stageActionDur = 4, stageActionElapsed = 0, stageSleeping = false;
const ACTION_LABEL = { idle: 'observando', dance: 'dançando', jump: 'pulando', run: 'correndo', crouch: 'agachando', play: 'brincando com o pet' };

function initStage() {
  const cv = $('#agentStage');
  stageRenderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  stageRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stageScene = new THREE.Scene();
  stageCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  stageCam.position.set(0, 1.1, STAGE_CAM_Z); applyStageZoom();
  stageScene.add(new THREE.AmbientLight(0x6070a0, 1.9));
  const k = new THREE.PointLight(0xbcd0ff, 90, 40); k.position.set(2.5, 4, 4); stageScene.add(k);
  const f = new THREE.PointLight(0x46e6b0, 30, 30); f.position.set(-3, -1, 2); stageScene.add(f);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(2.6, 40), new THREE.MeshBasicMaterial({ color: 0x0a0e22, transparent: true, opacity: 0.5 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.25; stageScene.add(floor);
}

function resizeStage() {
  if (!stageRenderer) return;
  const el = $('#panelStage'); const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  stageRenderer.setSize(w, h, false);
  stageCam.aspect = w / h; stageCam.updateProjectionMatrix();
  stageW = w; stageH = h;
}

// pet determinístico por agente: peixe-robô ou cão-android
function petKindFor(id) { let s = 0; for (const c of id) s += c.charCodeAt(0); return s % 2 ? 'dog' : 'fish'; }
function buildPet(kind, color) {
  const g = new THREE.Group(), M = mats(color);
  if (kind === 'fish') {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), M.c()); body.scale.set(1.5, 1, 0.8); g.add(body);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.26, 4), M.c()); tail.rotation.z = -Math.PI / 2; tail.position.x = -0.32; g.add(tail);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), new THREE.MeshBasicMaterial({ color: 0x0c1020 })); eye.position.set(0.2, 0.06, 0.14); g.add(eye);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.18, 4), M.c()); dorsal.position.set(0, 0.2, 0); g.add(dorsal);
    g.userData.tail = tail;
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.22), M.c()); body.position.y = 0.22; g.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), M.c()); head.position.set(0.32, 0.34, 0); g.add(head);
    [[0.36, 0.06], [0.28, 0.06]].forEach(([x, z]) => { const ear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.02), M.c()); ear.position.set(x, 0.47, z); g.add(ear); });
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.1), M.c()); snout.position.set(0.44, 0.3, 0); g.add(snout);
    [-0.14, 0.14].forEach(x => [-0.08, 0.08].forEach(z => { const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.06), M.c()); l.position.set(x, 0.04, z); g.add(l); }));
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.2), M.c()); tail.position.set(-0.26, 0.3, 0); g.add(tail);
    g.userData.tail = tail;
  }
  return g;
}

function setStageAgent(a, i) {
  if (!stageRenderer) initStage();
  if (stageChar) { disposeGroup(stageChar); stageScene.remove(stageChar); }
  if (stagePet)  { disposeGroup(stagePet);  stageScene.remove(stagePet); }
  const color = agentColor(a, i);
  stageRig = buildCharacter(agentCharId(a), color);
  stageChar = stageRig.group; stageChar.scale.setScalar(1.2); stageChar.position.y = -0.2;
  stageScene.add(stageChar);
  stagePet = buildPet(petKindFor(a.id), color); stagePet.position.set(1.25, -0.95, 0.3); stagePet.scale.setScalar(1.15);
  stageScene.add(stagePet);
  stageAction = 'idle'; stageActionElapsed = 0; stageActionDur = 3;
  $('#stageAction').textContent = ACTION_LABEL.idle;
  resizeStage();
  startStageLoop();
}

function nextStageAction() {
  const opts = ['idle', 'dance', 'jump', 'run', 'crouch'].concat(stagePet ? ['play'] : []);
  stageAction = opts[Math.floor(Math.random() * opts.length)];
  stageActionDur = 3 + Math.random() * 3;
  if (!stageSleeping) $('#stageAction').textContent = ACTION_LABEL[stageAction] || '';
}

function applyStageAction(t) {
  const r = stageRig, g = stageChar;
  let y = -0.2, swing = 0, armUp = 0, crouch = 0, yaw = Math.sin(t * 0.5) * 0.3;
  switch (stageAction) {
    case 'dance': swing = Math.sin(t * 8) * 0.6; armUp = 0.9 + Math.sin(t * 8) * 0.4; yaw = Math.sin(t * 4) * 0.6; break;
    case 'jump':  y = -0.2 + Math.abs(Math.sin(t * 4)) * 0.7; swing = Math.sin(t * 8) * 0.3; break;
    case 'run':   swing = Math.sin(t * 14) * 0.85; y = -0.2 + Math.abs(Math.sin(t * 14)) * 0.05; break;
    case 'crouch':crouch = 0.45 + Math.sin(t * 2) * 0.12; break;
    case 'play':  yaw = 0.7; armUp = 0.4 + Math.sin(t * 6) * 0.5; if (stagePet) stagePet.position.x = 1.0 + Math.sin(t * 3) * 0.25; break;
    default:      swing = Math.sin(t * 1.6) * 0.13;
  }
  g.rotation.y = yaw;
  g.position.y = y - crouch * 0.4;
  if (r.armL) r.armL.rotation.x = swing - armUp;
  if (r.armR) r.armR.rotation.x = -swing - armUp;
  if (r.legL) r.legL.rotation.x = -swing * 0.7;
  if (r.legR) r.legR.rotation.x = swing * 0.7;
  if (r.head) r.head.rotation.x = crouch * 0.3;
  if (r.eyeL) { r.eyeL.scale.y = 1; if (r.eyeR && r.eyeR !== r.eyeL) r.eyeR.scale.y = 1; }
}

function stageStep() {
  if (!stageRenderer || !stageChar) return;
  stageT += 0.016;
  const el = $('#panelStage');
  if (el && (el.clientWidth !== stageW || el.clientHeight !== stageH)) resizeStage();

  // pet sempre vivo (nada/anda)
  if (stagePet) {
    stagePet.position.y = -0.92 + Math.sin(stageT * 3) * 0.08;
    stagePet.rotation.y = Math.sin(stageT * 0.8) * 0.6;
    if (stagePet.userData.tail) stagePet.userData.tail.rotation.y = Math.sin(stageT * 11) * 0.6;
  }

  if (stageSleeping) {
    stageChar.rotation.z = 0.55; stageChar.rotation.y = 0;
    stageChar.position.y = -0.5 + Math.sin(stageT * 1.1) * 0.05;
    if (stageRig.eyeL) { stageRig.eyeL.scale.y = 0.1; if (stageRig.eyeR && stageRig.eyeR !== stageRig.eyeL) stageRig.eyeR.scale.y = 0.1; }
    stageRig.update?.(stageT, false);
    stageRenderer.render(stageScene, stageCam);
    return;
  }

  stageChar.rotation.z = 0;
  stageActionElapsed += 0.016;
  if (stageActionElapsed > stageActionDur) { stageActionElapsed = 0; nextStageAction(); }
  applyStageAction(stageT);
  stageRig.update?.(stageT, true);
  stageRenderer.render(stageScene, stageCam);
}

function startStageLoop() { if (stageRAF) return; const loop = () => { stageRAF = requestAnimationFrame(loop); stageStep(); }; loop(); }
function stopStageLoop() { if (stageRAF) { cancelAnimationFrame(stageRAF); stageRAF = null; } }

function setStageSleep(on) {
  stageSleeping = on;
  $('#stageSleep').classList.toggle('hidden', !on);
  if (on) $('#stageAction').textContent = '';
}
function applyStageSleepFromAgent(a) {
  setStageSleep(!!(a && a.rateLimited && a.rateLimitedUntil));
}

$('#stageZoomIn').onclick  = () => setStageZoom(stageZoom * 1.18);
$('#stageZoomOut').onclick = () => setStageZoom(stageZoom / 1.18);
addEventListener('resize', resizeStage);

// deep-link: #v=<3d|cards> e #a=<id>&t=<chat|activity|design>
function applyHash() {
  const vm = location.hash.match(/v=(3d|cards)/);
  if (vm) setView(vm[1]);
  const m = location.hash.match(/a=([a-zA-Z0-9_\-]+)/);
  if (!m) return;
  const id = m[1];
  if (!agents.some(x => x.id === id)) return;
  selectAgent(id);
  const tm = location.hash.match(/t=(chat|activity|design)/);
  if (tm) switchTab(tm[1]);
}
addEventListener('hashchange', applyHash);

setView(view);
loadAgents();
