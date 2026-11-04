import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Hero scene: a globe of phones around a glowing verifier core.
 * Peach pulses carry tasks out to devices; orange pulses carry results back to the core.
 * A scan sweeps the globe every few seconds and lights the phones it passes.
 * Interactions: hover a phone to spotlight it, click to dispatch a burst of tasks, drag to spin.
 * Purely illustrative: it never shows real network activity.
 */
export interface SceneHandle {
  setMotion(on: boolean): void;
  setScroll(p: number): void;
  dispose(): void;
}

const ORANGE = new THREE.Color("#ff7a45");
const PEACH = new THREE.Color("#ffd9c4");
const FRAME = new THREE.Color("#3a4152");
const IDLE = new THREE.Color("#9aa3b5");
const R = 3.1; // globe radius

function fibonacciSphere(n: number, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2; // offset keeps devices off the exact poles
    const rad = Math.sqrt(1 - y * y);
    const t = golden * i;
    pts.push(new THREE.Vector3(Math.cos(t) * rad * r, y * r * 0.82, Math.sin(t) * rad * r));
  }
  return pts;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft beam: bright at the base, fading to nothing along its length and at the sides. */
function rayTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 256;
  const g = c.getContext("2d")!;
  const v = g.createLinearGradient(0, 256, 0, 0);
  v.addColorStop(0, "rgba(255,255,255,0.9)");
  v.addColorStop(0.35, "rgba(255,255,255,0.25)");
  v.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = "destination-in";
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, "rgba(0,0,0,0)");
  h.addColorStop(0.5, "rgba(0,0,0,1)");
  h.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Eight phone screens drawn once into a 4×2 atlas, so neighbouring devices show different apps:
 *  a task ring, vector bars, a verified list, charging, the 64-record grid, a reward chart, a log and a
 *  lock screen. Greyscale, so each instance can tint it (idle tones, orange while working). */
export const SCREEN_VARIANTS = 8;
function screenAtlas(): THREE.Texture {
  const W = 256, H = 512, r = 30;
  const c = document.createElement("canvas");
  c.width = W * 4; c.height = H * 2;
  const g = c.getContext("2d")!;
  const rr = (x: number, y: number, w: number, h: number, rad: number) => {
    g.beginPath();
    g.moveTo(x + rad, y);
    g.arcTo(x + w, y, x + w, y + h, rad);
    g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad);
    g.arcTo(x, y, x + w, y, rad);
    g.closePath();
  };
  const fill = (a: number) => { g.fillStyle = `rgba(255,255,255,${a})`; };
  const bar = (x: number, y: number, w: number, h: number, a: number) => { fill(a); rr(x, y, w, h, Math.min(h / 2, 8)); g.fill(); };
  const draws: (() => void)[] = [
    // 0 · task card with a progress ring
    () => {
      bar(26, 70, 120, 16, 0.85); bar(26, 98, 190, 10, 0.35); bar(26, 116, 150, 10, 0.35);
      fill(0.16); rr(22, 160, W - 44, 170, 20); g.fill();
      g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 8; g.lineCap = "round";
      g.beginPath(); g.arc(W / 2, 245, 46, -Math.PI / 2, Math.PI * 1.15); g.stroke();
      bar(26, 372, W - 52, 12, 0.25); bar(26, 372, (W - 52) * 0.68, 12, 0.95); bar(26, 404, 110, 10, 0.3);
    },
    // 1 · vector bars
    () => {
      bar(26, 70, 150, 16, 0.85); bar(26, 98, 100, 10, 0.35);
      const hs = [0.45, 0.8, 0.3, 0.65, 0.95, 0.5, 0.72, 0.38, 0.86, 0.58];
      hs.forEach((h, i) => bar(26 + i * 21, 330 - h * 170, 14, h * 170, 0.35 + h * 0.6));
      bar(26, 350, W - 52, 4, 0.3);
      for (let i = 0; i < 3; i++) { bar(26, 380 + i * 26, 70, 10, 0.3); bar(W - 26 - 60, 380 + i * 26, 60, 10, 0.6); }
    },
    // 2 · verified list with a big check
    () => {
      fill(0.9); g.beginPath(); g.arc(W / 2, 150, 54, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(40,44,52,1)"; g.lineWidth = 12; g.lineCap = "round"; g.lineJoin = "round";
      g.beginPath(); g.moveTo(W / 2 - 24, 152); g.lineTo(W / 2 - 6, 170); g.lineTo(W / 2 + 26, 134); g.stroke();
      for (let i = 0; i < 5; i++) {
        const y = 248 + i * 40;
        fill(0.85); g.beginPath(); g.arc(40, y + 6, 8, 0, Math.PI * 2); g.fill();
        bar(60, y, 110 + ((i * 37) % 50), 12, 0.45);
      }
    },
    // 3 · charging
    () => {
      fill(0.2); rr(W / 2 - 50, 120, 100, 200, 18); g.fill();
      fill(0.85); rr(W / 2 - 40, 190, 80, 120, 10); g.fill();
      fill(0.35); rr(W / 2 - 18, 104, 36, 14, 5); g.fill();
      g.fillStyle = "rgba(40,44,52,1)";
      g.beginPath(); g.moveTo(W / 2 + 6, 200); g.lineTo(W / 2 - 18, 252); g.lineTo(W / 2 - 2, 252); g.lineTo(W / 2 - 8, 296); g.lineTo(W / 2 + 18, 240); g.lineTo(W / 2 + 2, 240); g.closePath(); g.fill();
      bar(W / 2 - 50, 350, 100, 22, 0.9); bar(W / 2 - 70, 388, 140, 10, 0.35);
    },
    // 4 · the 64-record grid
    () => {
      bar(26, 70, 130, 16, 0.85);
      for (let i = 0; i < 64; i++) { const x = 30 + (i % 8) * 25, y = 120 + Math.floor(i / 8) * 25; fill(i < 46 ? 0.85 : 0.18); rr(x, y, 18, 18, 4); g.fill(); }
      bar(26, 336, W - 52, 12, 0.25); bar(26, 336, (W - 52) * 0.72, 12, 0.9);
      bar(26, 368, 90, 10, 0.35);
    },
    // 5 · reward with a rising line
    () => {
      bar(26, 70, 90, 12, 0.4); bar(26, 94, 170, 34, 0.95);
      g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 6; g.lineJoin = "round"; g.lineCap = "round";
      const pts = [[26, 300], [62, 280], [98, 288], [134, 240], [170, 252], [206, 200], [230, 186]];
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x!, y!) : g.moveTo(x!, y!))); g.stroke();
      fill(0.12); g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x!, y!) : g.moveTo(x!, y!))); g.lineTo(230, 320); g.lineTo(26, 320); g.closePath(); g.fill();
      bar(26, 350, W - 52, 18, 0.25); bar(26, 350, (W - 52) * 0.75, 18, 0.85);
      bar(26, 386, 80, 10, 0.4); bar(W - 26 - 60, 386, 60, 10, 0.4);
    },
    // 6 · log lines
    () => {
      fill(0.08); rr(18, 56, W - 36, 400, 16); g.fill();
      const ws = [150, 190, 120, 170, 90, 200, 140, 110, 180, 130, 160, 100, 190];
      ws.forEach((w, i) => { bar(32, 76 + i * 28, 10, 10, 0.7); bar(50, 76 + i * 28, w * 0.85, 10, i === ws.length - 1 ? 0.95 : 0.4); });
    },
    // 7 · lock screen
    () => {
      bar(W / 2 - 60, 76, 120, 12, 0.4); bar(W / 2 - 80, 104, 160, 58, 0.95);
      for (let i = 0; i < 2; i++) { fill(0.18); rr(22, 220 + i * 92, W - 44, 76, 18); g.fill(); bar(40, 238 + i * 92, 36, 36, 0.7); bar(88, 242 + i * 92, 110, 10, 0.6); bar(88, 262 + i * 92, 80, 8, 0.35); }
      fill(0.5); g.beginPath(); g.arc(56, 440, 20, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(W - 56, 440, 20, 0, Math.PI * 2); g.fill();
    },
  ];
  draws.forEach((draw, v) => {
    g.save();
    g.translate((v % 4) * W, Math.floor(v / 4) * H);
    const tone = 0.85 + ((v * 3) % 5) * 0.04;
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, `rgb(${Math.round(106 * tone)},${Math.round(111 * tone)},${Math.round(124 * tone)})`);
    bg.addColorStop(1, "#2c3039");
    rr(1, 1, W - 2, H - 2, r); g.fillStyle = bg; g.fill();
    g.save(); rr(1, 1, W - 2, H - 2, r); g.clip();
    fill(0.55); rr(W / 2 - 28, 14, 56, 12, 6); g.fill(); // camera notch
    draw();
    fill(0.3); rr(W / 2 - 40, H - 24, 80, 8, 4); g.fill(); // home bar
    g.restore();
    g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  return t;
}

/** Rim-lit energy shell: transparent in the middle, glowing at the edges. */
function fresnelMaterial(color: THREE.Color, power: number, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uPower: { value: power }, uStrength: { value: strength } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uPower; uniform float uStrength;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), uPower) * uStrength;
        gl_FragColor = vec4(uColor * f, f);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

export function createConstellation(canvas: HTMLCanvasElement, opts: { motion: boolean; compact: boolean }): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  // Render at least at 1.5x so edges and 1px lines stay crisp on standard (1x) monitors.
  renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.set(0, 0.4, 9.2);

  const world = new THREE.Group();
  scene.add(world);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(4, 6, 5);
  scene.add(key);
  const back = new THREE.DirectionalLight(new THREE.Color("#6078ff"), 0.8);
  back.position.set(-5, -2, -4);
  scene.add(back);
  const rim = new THREE.PointLight(ORANGE, 40, 12, 2);
  world.add(rim);

  const glowTex = glowTexture();
  const rayTex = rayTexture();

  // ── Verifier core: faceted crystal, energy shell, geodesic cages, halo and rotating light rays.
  const coreGroup = new THREE.Group();
  world.add(coreGroup);
  const coreMat = new THREE.MeshPhysicalMaterial({ color: ORANGE, emissive: ORANGE, emissiveIntensity: 0.6, metalness: 0.1, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05, flatShading: true });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 1), coreMat);
  coreGroup.add(core);
  const energy = new THREE.Mesh(new THREE.SphereGeometry(0.98, 64, 64), fresnelMaterial(new THREE.Color("#ff9a66"), 2.4, 1.4));
  coreGroup.add(energy);
  const aura = new THREE.Mesh(new THREE.SphereGeometry(1.5, 48, 48), fresnelMaterial(ORANGE, 3.5, 0.55));
  coreGroup.add(aura);
  const cageMat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.32 });
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.95, 2), 1), cageMat);
  coreGroup.add(shell);
  const shell2Mat = new THREE.LineBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.45 });
  const shell2 = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.25, 0)), shell2Mat);
  coreGroup.add(shell2);
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: ORANGE, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreGlow.scale.setScalar(2.6);
  coreGroup.add(coreGlow);
  const coreHot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color("#fff1e6"), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreHot.scale.setScalar(0.9);
  coreGroup.add(coreHot);

  const rays = new THREE.Group();
  const rayMat = new THREE.MeshBasicMaterial({ map: rayTex, color: new THREE.Color("#ffb38a"), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const RAYS = opts.compact ? 8 : 14;
  const rayGeo = new THREE.PlaneGeometry(0.35, 3.6).translate(0, 1.8, 0);
  for (let i = 0; i < RAYS; i++) {
    const ray = new THREE.Mesh(rayGeo, rayMat);
    ray.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
    ray.scale.set(0.6 + Math.random() * 0.8, 0.5 + Math.random() * 0.7, 1);
    rays.add(ray);
  }
  coreGroup.add(rays);

  // ── Orbit lines, plus a stream of sparks riding the inner orbit.
  const ringMat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.22 });
  const rings: THREE.Object3D[] = [];
  for (const [rx, rz, r] of [[1.35, 0.2, 3.55], [1.75, -0.5, 4.0]] as const) {
    const pts = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2).getPoints(256).map((v) => new THREE.Vector3(v.x, v.y, 0));
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
    ring.rotation.set(rx, 0, rz);
    world.add(ring);
    rings.push(ring);
  }
  const SPARKS = opts.compact ? 24 : 48;
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ map: glowTex, color: new THREE.Color("#ffc2a3"), size: 0.12, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  rings[0]!.add(sparks);
  const sparkPhase = Array.from({ length: SPARKS }, (_, i) => i / SPARKS + Math.random() * 0.01);

  // ── Phones: precise rounded metal frames, upright and facing outward like a tiled globe.
  const N = opts.compact ? 30 : 44;
  const positions = fibonacciSphere(N, R);
  const bodyGeo = new RoundedBoxGeometry(0.4, 0.8, 0.05, 6, 0.06);
  // Instance colours carry each frame's finish, so the base colour is white.
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.95, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, N);
  const screenTex = screenAtlas();
  const screenGeo = new THREE.PlaneGeometry(0.36, 0.72);
  // Each instance picks one of the atlas screens through a per-instance attribute.
  const variant = new Float32Array(N);
  for (let i = 0; i < N; i++) variant[i] = (i * 5 + Math.floor(i / SCREEN_VARIANTS)) % SCREEN_VARIANTS;
  screenGeo.setAttribute("aVariant", new THREE.InstancedBufferAttribute(variant, 1));
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, transparent: true, alphaTest: 0.5, toneMapped: false });
  screenMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aVariant;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n  vMapUv = vec2((vMapUv.x + mod(aVariant, 4.0)) * 0.25, (vMapUv.y + 1.0 - floor(aVariant / 4.0)) * 0.5);");
  };
  const screens = new THREE.InstancedMesh(screenGeo, screenMat, N);
  // Device forms and frame finishes, so the globe reads as a mix of real hardware.
  const FORMS = [
    { name: "phone", sx: 1, sy: 1 },
    { name: "slim phone", sx: 0.9, sy: 1.04 },
    { name: "compact phone", sx: 0.92, sy: 0.86 },
    { name: "tablet", sx: 1.45, sy: 1.08 },
    { name: "phone", sx: 1.04, sy: 0.96 },
  ];
  const FINISHES = [FRAME, new THREE.Color("#b9bec8"), new THREE.Color("#c8a98a"), new THREE.Color("#2b3a5c"), new THREE.Color("#1d2029"), new THREE.Color("#ff7a45")];
  const IDLE_TONES = [IDLE, new THREE.Color("#a9bfdc"), new THREE.Color("#c9b6a8"), new THREE.Color("#b4abd6"), new THREE.Color("#a3cbc1")];
  const m = new THREE.Matrix4();
  const sc3 = new THREE.Vector3();
  const tmp = new THREE.Object3D();
  const SCREEN_OFFSET = new THREE.Matrix4().makeTranslation(0, 0, 0.027);
  const base: { pos: THREE.Vector3; quat: THREE.Quaternion; phase: number; form: (typeof FORMS)[number]; idle: THREE.Color }[] = [];
  positions.forEach((p, i) => {
    tmp.position.copy(p);
    tmp.up.set(0, 1, 0);
    tmp.lookAt(p.x * 2, p.y * 2, p.z * 2); // screen faces outward, kept upright
    tmp.updateMatrix();
    const form = FORMS[(i * 3 + 1) % FORMS.length]!;
    // Mostly graphite, silver and champagne; a few navy, black and one or two orange accents.
    const fin = i % 11 === 4 ? 5 : [0, 1, 0, 2, 3, 0, 1, 4, 2, 0][i % 10]!;
    const idle = IDLE_TONES[(i * 7) % IDLE_TONES.length]!;
    base.push({ pos: p.clone(), quat: tmp.quaternion.clone(), phase: Math.random() * Math.PI * 2, form, idle });
    sc3.set(form.sx, form.sy, 1);
    m.compose(p, tmp.quaternion, sc3);
    bodies.setMatrixAt(i, m);
    bodies.setColorAt(i, FINISHES[fin]!);
    m.multiply(SCREEN_OFFSET);
    screens.setMatrixAt(i, m);
    screens.setColorAt(i, idle);
  });
  world.add(bodies, screens);

  // Links from each device to the core.
  const linkPos = new Float32Array(N * 6);
  positions.forEach((p, i) => linkPos.set([p.x * 0.97, p.y * 0.97, p.z * 0.97, p.x * 0.22, p.y * 0.22, p.z * 0.22], i * 6));
  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPos, 3));
  const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false }));
  world.add(links);

  // Highlight beam from the core to the hovered phone.
  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const beamMat = new THREE.LineBasicMaterial({ color: new THREE.Color("#ffb38a"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const beam = new THREE.Line(beamGeo, beamMat);
  world.add(beam);

  // Scan ring: sweeps the globe from top to bottom and lights the phones it passes.
  const scanPts = new THREE.EllipseCurve(0, 0, 1, 1, 0, Math.PI * 2).getPoints(128).map((v) => new THREE.Vector3(v.x, 0, v.y));
  const scanMat = new THREE.LineBasicMaterial({ color: new THREE.Color("#ffb38a"), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const scan = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(scanPts), scanMat);
  world.add(scan);
  const scanGlowMat = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const scanDisc = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 96).rotateX(-Math.PI / 2), scanGlowMat);
  scan.add(scanDisc);

  // Shockwave: a ring that bursts out from the core on click (always faces the camera).
  const shockMat = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const shock = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 128), shockMat);
  scene.add(shock);

  // Ambient dust.
  const dustN = opts.compact ? 180 : 360;
  const dustPos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(2 + Math.random() * 4.5);
    dustPos.set([v.x, v.y, v.z], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: PEACH, size: 0.018, transparent: true, opacity: 0.5, depthWrite: false }));
  world.add(dust);

  // Pulses travelling along links: out (task, peach) then back (result, orange).
  interface Pulse { sprite: THREE.Sprite; dev: number; t: number; speed: number; back: boolean; burst: boolean }
  const pulses: Pulse[] = [];
  const makePulse = (burst: boolean, dev = Math.floor(Math.random() * N)): Pulse => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: PEACH, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sprite.scale.setScalar(0.22);
    world.add(sprite);
    const p: Pulse = { sprite, dev, t: burst ? 0 : Math.random(), speed: burst ? 0.9 + Math.random() * 0.4 : 0.35 + Math.random() * 0.35, back: burst ? false : Math.random() > 0.5, burst };
    pulses.push(p);
    return p;
  };
  for (let i = 0; i < (opts.compact ? 10 : 18); i++) makePulse(false);
  const flash = new Float32Array(N);
  // Real work only (a task arrived), kept apart from hover and scan highlights so the label tells the truth.
  const work = new Float32Array(N);
  // Idle status per device, matched to what its screen shows.
  const IDLE_STATUS: Record<number, string> = { 2: "result verified", 3: "charging", 6: "uploading result", 7: "locked · waiting for charger" };
  const hoverScale = new Float32Array(N);
  const col = new THREE.Color();

  // Hover label, drawn as HTML next to the canvas.
  const label = document.createElement("div");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;opacity:0;transition:opacity 200ms ease;z-index:5;padding:8px 12px;border-radius:12px;border:1px solid rgba(255,122,69,0.45);background:rgba(15,19,27,0.78);backdrop-filter:blur(8px);color:#eceef3;font:600 12px/1.3 'Manrope',sans-serif;white-space:nowrap;box-shadow:0 10px 30px -10px rgba(255,122,69,0.5)";
  canvas.parentElement?.appendChild(label);

  // ── Interaction state.
  let motion = opts.motion;
  let scroll = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, inside: false, cx: 0, cy: 0 };
  const drag = { active: false, lastX: 0, lastY: 0, vy: 0, vx: 0, rotY: 0, rotX: 0 };
  let energyBoost = 0; // core flare after a click
  let hovered = -1;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const isInteractive = (el: EventTarget | null) => !!(el as Element | null)?.closest?.("a,button,input,select,textarea,label,[role=button]");
  const inCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  // The globe is the right part of the hero; text sits over the left part, so only react there.
  const overGlobe = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = (e.clientY - r.top) / r.height - 0.5;
    return Math.hypot(dx * (r.width / r.height), dy) < 0.48;
  };
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    pointer.cx = e.clientX - r.left;
    pointer.cy = e.clientY - r.top;
    pointer.inside = e.pointerType === "mouse" && inCanvas(e) && overGlobe(e) && !isInteractive(e.target);
    if (drag.active) {
      const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX; drag.lastY = e.clientY;
      drag.vy = dx * 0.006; drag.vx = dy * 0.004;
      drag.rotY += drag.vy; drag.rotX = Math.max(-0.6, Math.min(0.6, drag.rotX + drag.vx));
    }
  };
  let downAt = { x: 0, y: 0, t: 0 };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || !inCanvas(e) || !overGlobe(e) || isInteractive(e.target)) return;
    e.preventDefault(); // no text selection while dragging the globe
    drag.active = true; drag.lastX = e.clientX; drag.lastY = e.clientY;
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onUp = (e: PointerEvent) => {
    if (!drag.active) return;
    drag.active = false;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    if (moved < 6 && performance.now() - downAt.t < 400) burst(hovered);
  };
  // Touch: a tap on the globe dispatches a burst (no drag, so page scroll stays free).
  let touchStart = { x: 0, y: 0, t: 0 };
  const onTouchDown = (e: PointerEvent) => { if (e.pointerType !== "mouse") touchStart = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const onTap = (e: PointerEvent) => {
    if (e.pointerType === "mouse" || !inCanvas(e) || isInteractive(e.target)) return;
    if (Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) < 8 && performance.now() - touchStart.t < 350) burst(-1);
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerdown", onTouchDown, { passive: true });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointerup", onTap);

  let shockT = -1;
  function burst(focus: number) {
    energyBoost = 1;
    shockT = 0;
    const count = opts.compact ? 10 : 18;
    for (let i = 0; i < count; i++) makePulse(true, focus >= 0 && i < 4 ? focus : Math.floor(Math.random() * N));
  }

  let scanT = -1;
  let nextScan = 2.5;

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit the device sphere (radius ~3.3) to the canvas: about 74% of the height on wide canvases,
    // and slightly wider than the screen on tall phone canvases where it sits behind the text.
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const aspect = w / h;
    camera.position.z = aspect < 0.9
      ? 3.3 / (1.05 * tanHalf * aspect)
      : Math.max(3.3 / (0.74 * tanHalf), 3.3 / (0.8 * tanHalf * aspect));
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; }, { threshold: 0 });
  io.observe(canvas);

  const intro = document.getElementById("an-intro");
  const clock = new THREE.Clock();
  let raf = 0;
  let elapsed = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const wp = new THREE.Vector3();
  const host = canvas.parentElement!;

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden || intro?.hidden === false) { clock.getDelta(); return; }
    const dt = Math.min(clock.getDelta(), 0.05);
    if (motion) elapsed += dt;
    const t = elapsed;
    const md = motion ? dt : 0;

    // Spin: idle drift + drag (with inertia) + pointer parallax + scroll.
    if (!drag.active) { drag.rotY += drag.vy; drag.vy *= 0.94; drag.rotX *= 0.97; }
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;
    world.rotation.y = t * 0.12 + drag.rotY + pointer.x * 0.3 + scroll * 1.2;
    world.rotation.x = 0.18 + drag.rotX + pointer.y * 0.15 + scroll * 0.25;
    world.position.y = -scroll * 0.8;
    world.scale.setScalar(1 - scroll * 0.12);

    // Core: breathing glow that flares after a click.
    energyBoost = Math.max(0, energyBoost - dt * 0.8);
    const breathe = Math.sin(t * 2.2);
    core.rotation.set(t * 0.4, t * 0.55, 0);
    core.scale.setScalar(1 + energyBoost * 0.35 + breathe * 0.03);
    coreMat.emissiveIntensity = 0.6 + energyBoost * 1.6 + breathe * 0.1;
    shell.rotation.set(-t * 0.15, t * 0.2, t * 0.05);
    shell2.rotation.set(t * 0.1, -t * 0.12, 0);
    shell2Mat.opacity = 0.45 + energyBoost * 0.4;
    (energy.material as THREE.ShaderMaterial).uniforms.uStrength!.value = 1.3 + breathe * 0.15 + energyBoost * 1.5;
    energy.scale.setScalar(1 + breathe * 0.02 + energyBoost * 0.12);
    (aura.material as THREE.ShaderMaterial).uniforms.uStrength!.value = 0.5 + energyBoost * 0.8;
    coreGlow.material.opacity = 0.55 + breathe * 0.08 + energyBoost * 0.35;
    coreGlow.scale.setScalar(2.6 + energyBoost * 1.6);
    coreHot.material.opacity = 0.85 + energyBoost * 0.15;
    rays.rotation.set(t * 0.07, t * 0.11, t * 0.05);
    rayMat.opacity = 0.28 + Math.sin(t * 1.3) * 0.06 + energyBoost * 0.4;
    rim.intensity = 40 + energyBoost * 60;

    rings[0]!.rotation.z = 0.2 + t * 0.05;
    rings[1]!.rotation.z = -0.5 - t * 0.04;
    dust.rotation.y = -t * 0.02;
    for (let i = 0; i < SPARKS; i++) {
      const ph = (sparkPhase[i]! + t * 0.04) % 1;
      const ang = ph * Math.PI * 2;
      const wob = 1 + Math.sin(ph * 40 + t) * 0.01;
      sparkPos[i * 3] = Math.cos(ang) * 3.55 * wob;
      sparkPos[i * 3 + 1] = Math.sin(ang) * 3.55 * wob;
      sparkPos[i * 3 + 2] = 0;
    }
    sparkGeo.attributes.position!.needsUpdate = true;

    // Scan sweep every ~7 s.
    if (motion) {
      nextScan -= dt;
      if (nextScan <= 0 && scanT < 0) { scanT = 0; nextScan = 7; }
    }
    if (scanT >= 0) {
      scanT += md * 0.45;
      const yN = 1 - scanT * 2; // +1 to -1
      const y = yN * R * 0.82;
      const rad = Math.max(0.01, Math.sqrt(Math.max(0, 1 - yN * yN)) * R * 1.02);
      scan.position.y = y;
      scan.scale.set(rad, 1, rad);
      const fade = Math.sin(Math.min(1, scanT) * Math.PI);
      scanMat.opacity = 0.9 * fade;
      scanGlowMat.opacity = 0.25 * fade;
      for (let i = 0; i < N; i++) if (Math.abs(base[i]!.pos.y - y) < 0.12) flash[i] = Math.max(flash[i]!, 1.1);
      if (scanT >= 1) { scanT = -1; scanMat.opacity = 0; scanGlowMat.opacity = 0; }
    }

    // Shockwave after a click.
    if (shockT >= 0) {
      shockT += dt * 0.9;
      shock.position.copy(world.position);
      shock.quaternion.copy(camera.quaternion);
      shock.scale.setScalar(0.8 + shockT * 6);
      shockMat.opacity = Math.max(0, 0.9 * (1 - shockT));
      if (shockT >= 1) { shockT = -1; shockMat.opacity = 0; }
    }

    // Hover: pick the phone under the cursor.
    hovered = -1;
    if (pointer.inside && !drag.active) {
      ndc.set((pointer.cx / canvas.clientWidth) * 2 - 1, -(pointer.cy / canvas.clientHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      world.updateMatrixWorld();
      const hit = raycaster.intersectObject(bodies, false)[0];
      if (hit && hit.instanceId !== undefined) hovered = hit.instanceId;
    }
    const cursor = drag.active ? "grabbing" : hovered >= 0 ? "pointer" : pointer.inside ? "grab" : "";
    if (document.body.style.cursor !== cursor) document.body.style.cursor = cursor;

    // Phones: gentle bob, hover lift, screen colour follows work.
    for (let i = 0; i < N; i++) {
      const bb = base[i]!;
      const target = i === hovered ? 1 : 0;
      hoverScale[i] = hoverScale[i]! + (target - hoverScale[i]!) * 0.18;
      const hs = hoverScale[i]!;
      const bob = Math.sin(t * 1.3 + bb.phase) * 0.012;
      a.copy(bb.pos).multiplyScalar(1 + bob + hs * 0.08);
      const grow = 1 + hs * 0.45;
      sc3.set(bb.form.sx * grow, bb.form.sy * grow, grow);
      m.compose(a, bb.quat, sc3);
      bodies.setMatrixAt(i, m);
      m.multiply(SCREEN_OFFSET);
      screens.setMatrixAt(i, m);
      if (i === hovered) flash[i] = Math.max(flash[i]!, 1);
      flash[i] = Math.max(0, flash[i]! - dt * 1.4);
      work[i] = Math.max(0, work[i]! - dt * 0.6);
      col.copy(bb.idle).lerp(ORANGE, Math.min(1, flash[i]!)).lerp(PEACH, Math.max(0, flash[i]! - 0.7));
      screens.setColorAt(i, col);
    }
    bodies.instanceMatrix.needsUpdate = true;
    screens.instanceMatrix.needsUpdate = true;
    if (screens.instanceColor) screens.instanceColor.needsUpdate = true;

    // Beam + label for the hovered phone.
    if (hovered >= 0) {
      const pos = base[hovered]!.pos;
      const arr = beamGeo.attributes.position!.array as Float32Array;
      arr.set([pos.x * 0.15, pos.y * 0.15, pos.z * 0.15, pos.x, pos.y, pos.z]);
      beamGeo.attributes.position!.needsUpdate = true;
      beamMat.opacity += (0.9 - beamMat.opacity) * 0.2;
      wp.copy(pos).applyMatrix4(world.matrixWorld).project(camera);
      const x = (wp.x * 0.5 + 0.5) * canvas.clientWidth;
      const y = (-wp.y * 0.5 + 0.5) * canvas.clientHeight;
      label.textContent = `Device ${String(hovered + 1).padStart(2, "0")} · ${base[hovered]!.form.name} · ${work[hovered]! > 0.05 ? "computing 64 records" : (IDLE_STATUS[variant[hovered]!] ?? "idle")} · click to dispatch`;
      // Keep the label inside the hero: flip to the left of the device near the right edge.
      const lw = label.offsetWidth, lh = label.offsetHeight;
      const vw = Math.min(canvas.clientWidth, window.innerWidth - canvas.getBoundingClientRect().left);
      let lx = x + 18;
      if (lx + lw > vw - 12) lx = x - 18 - lw;
      lx = Math.max(8, Math.min(lx, vw - lw - 12));
      const ly = Math.max(8, Math.min(y - 40, canvas.clientHeight - lh - 8));
      label.style.transform = `translate(${lx.toFixed(0)}px, ${ly.toFixed(0)}px)`;
      label.style.opacity = "1";
    } else {
      beamMat.opacity *= 0.85;
      label.style.opacity = "0";
    }

    for (let k = pulses.length - 1; k >= 0; k--) {
      const p = pulses[k]!;
      p.t += md * p.speed;
      if (p.t >= 1) {
        p.t = 0;
        if (!p.back) { flash[p.dev] = 1.25; work[p.dev] = 1; } // task arrived: the screen lights up while it works
        p.back = !p.back;
        if (p.burst && !p.back) { // burst pulses retire after one round trip
          world.remove(p.sprite);
          p.sprite.material.dispose();
          pulses.splice(k, 1);
          continue;
        }
        if (!p.back) p.dev = Math.floor(Math.random() * N);
        p.sprite.material.color.copy(p.back ? ORANGE : PEACH);
      }
      const dev = base[p.dev]!.pos;
      a.copy(dev).multiplyScalar(0.22);
      b.copy(dev).multiplyScalar(0.97);
      const e = p.t * p.t * (3 - 2 * p.t);
      if (p.back) p.sprite.position.lerpVectors(b, a, e);
      else p.sprite.position.lerpVectors(a, b, e);
      p.sprite.scale.setScalar((p.burst ? 0.18 : 0.12) + Math.sin(p.t * Math.PI) * 0.14);
    }

    renderer.render(scene, camera);
  }
  frame();

  return {
    setMotion(on) { motion = on; },
    setScroll(p) { scroll = Math.max(0, Math.min(1, p)); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerdown", onTouchDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointerup", onTap);
      document.body.style.cursor = "";
      label.remove();
      host.style.cursor = "";
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      glowTex.dispose();
      rayTex.dispose();
      screenTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
