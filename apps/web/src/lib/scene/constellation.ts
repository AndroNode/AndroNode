import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Hero scene: a constellation of phones around a verifier core.
 * Peach pulses carry tasks out to devices; orange pulses carry results back to the core,
 * where they are checked. Purely illustrative: it never shows real network activity.
 */
export interface SceneHandle {
  setMotion(on: boolean): void;
  setScroll(p: number): void;
  dispose(): void;
}

const ORANGE = new THREE.Color("#ff7a45");
const PEACH = new THREE.Color("#ffd9c4");
const FRAME = new THREE.Color("#3a4152");

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

/** A phone screen drawn once: rounded glass, status bar, a task card and a progress bar.
 *  Greyscale so each instance can tint it (idle slate, orange while working). */
function screenTexture(): THREE.Texture {
  const W = 256, H = 512, r = 30;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
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
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#6a6f7c");
  bg.addColorStop(1, "#2c3039");
  rr(0, 0, W, H, r); g.fillStyle = bg; g.fill();
  g.fillStyle = "rgba(255,255,255,0.55)";
  rr(W / 2 - 28, 14, 56, 12, 6); g.fill(); // camera notch
  g.fillStyle = "rgba(255,255,255,0.85)";
  rr(26, 70, 120, 16, 8); g.fill();
  g.fillStyle = "rgba(255,255,255,0.35)";
  rr(26, 98, 190, 10, 5); g.fill();
  rr(26, 116, 150, 10, 5); g.fill();
  g.fillStyle = "rgba(255,255,255,0.16)";
  rr(22, 160, W - 44, 170, 20); g.fill();
  g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 8;
  g.beginPath(); g.arc(W / 2, 245, 46, -Math.PI / 2, Math.PI * 1.15); g.stroke();
  g.fillStyle = "rgba(255,255,255,0.25)";
  rr(26, 372, W - 52, 12, 6); g.fill();
  g.fillStyle = "rgba(255,255,255,0.95)";
  rr(26, 372, (W - 52) * 0.68, 12, 6); g.fill();
  g.fillStyle = "rgba(255,255,255,0.3)";
  rr(26, 404, 110, 10, 5); g.fill();
  rr(W / 2 - 40, H - 24, 80, 8, 4); g.fill(); // home bar
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createConstellation(canvas: HTMLCanvasElement, opts: { motion: boolean; compact: boolean }): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  // Render at least at 1.5x so edges and 1px lines stay crisp on standard (1x) monitors.
  renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.set(0, 0.4, 9.2);

  const world = new THREE.Group();
  scene.add(world);

  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.PointLight(ORANGE, 30, 12, 2);
  rim.position.set(0, 0, 0);
  world.add(rim);

  // Verifier core: faceted orange crystal inside a slowly turning wire shell.
  // Verifier core: a polished faceted crystal, a fine geodesic cage and a tight halo.
  const coreMat = new THREE.MeshPhysicalMaterial({ color: ORANGE, emissive: ORANGE, emissiveIntensity: 0.35, metalness: 0.1, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, flatShading: true });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 1), coreMat);
  world.add(core);
  const cageMat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.32 });
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.95, 2), 1), cageMat);
  world.add(shell);
  const shell2 = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.25, 0)), new THREE.LineBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.45 }));
  world.add(shell2);
  const glowTex = glowTexture();
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: ORANGE, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreGlow.scale.setScalar(2.4);
  world.add(coreGlow);

  // Orbit rings.
  // Thin 1px orbit lines (crisper than thin tori, which shimmer at a distance).
  const ringMat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.22 });
  const rings: THREE.Object3D[] = [];
  for (const [rx, rz, r] of [[1.35, 0.2, 3.55], [1.75, -0.5, 4.0]] as const) {
    const pts = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2).getPoints(256).map((v) => new THREE.Vector3(v.x, v.y, 0));
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
    ring.rotation.set(rx, 0, rz);
    world.add(ring);
    rings.push(ring);
  }

  // Phones: instanced bodies with instanced emissive screens.
  // Phones: precise rounded metal frames, every one upright and facing outward like a tiled globe.
  const N = opts.compact ? 30 : 44;
  const positions = fibonacciSphere(N, 3.1);
  const bodyGeo = new RoundedBoxGeometry(0.4, 0.8, 0.05, 6, 0.06);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: FRAME, metalness: 0.95, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, N);
  const screenTex = screenTexture();
  const screenGeo = new THREE.PlaneGeometry(0.36, 0.72);
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, transparent: true, alphaTest: 0.5, toneMapped: false });
  const screens = new THREE.InstancedMesh(screenGeo, screenMat, N);
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3(1, 1, 1);
  const tmp = new THREE.Object3D();
  const SCREEN_OFFSET = new THREE.Matrix4().makeTranslation(0, 0, 0.027);
  const base: { pos: THREE.Vector3; quat: THREE.Quaternion; phase: number }[] = [];
  positions.forEach((p, i) => {
    tmp.position.copy(p);
    tmp.up.set(0, 1, 0);
    tmp.lookAt(p.x * 2, p.y * 2, p.z * 2); // screen faces outward, kept upright
    tmp.updateMatrix();
    base.push({ pos: p.clone(), quat: tmp.quaternion.clone(), phase: Math.random() * Math.PI * 2 });
    bodies.setMatrixAt(i, tmp.matrix);
    m.compose(p, tmp.quaternion, s).multiply(SCREEN_OFFSET);
    screens.setMatrixAt(i, m);
    screens.setColorAt(i, new THREE.Color("#9aa3b5"));
  });
  world.add(bodies, screens);

  // Links from each device to the core.
  const linkPos = new Float32Array(N * 6);
  positions.forEach((p, i) => linkPos.set([p.x * 0.97, p.y * 0.97, p.z * 0.97, p.x * 0.22, p.y * 0.22, p.z * 0.22], i * 6));
  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPos, 3));
  const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false }));
  world.add(links);

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
  interface Pulse { sprite: THREE.Sprite; dev: number; t: number; speed: number; back: boolean }
  const pulses: Pulse[] = [];
  const P = opts.compact ? 10 : 18;
  for (let i = 0; i < P; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: PEACH, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sprite.scale.setScalar(0.22);
    world.add(sprite);
    pulses.push({ sprite, dev: Math.floor(Math.random() * N), t: Math.random(), speed: 0.35 + Math.random() * 0.35, back: Math.random() > 0.5 });
  }
  const flash = new Float32Array(N);
  const idle = new THREE.Color("#9aa3b5");
  const col = new THREE.Color();

  // Interaction state.
  let motion = opts.motion;
  let scroll = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });

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

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden || intro?.hidden === false) { clock.getDelta(); return; }
    const dt = Math.min(clock.getDelta(), 0.05);
    if (motion) elapsed += dt;
    const t = elapsed;

    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;
    world.rotation.y = t * 0.12 + pointer.x * 0.35 + scroll * 1.2;
    world.rotation.x = 0.18 + pointer.y * 0.18 + scroll * 0.25;
    world.position.y = -scroll * 0.8;
    const sc = 1 - scroll * 0.12;
    world.scale.setScalar(sc);

    core.rotation.set(t * 0.4, t * 0.55, 0);
    shell.rotation.set(-t * 0.15, t * 0.2, t * 0.05);
    shell2.rotation.set(t * 0.1, -t * 0.12, 0);
    coreGlow.material.opacity = 0.5 + Math.sin(t * 2.2) * 0.08;
    rings[0]!.rotation.z = 0.2 + t * 0.05;
    rings[1]!.rotation.z = -0.5 - t * 0.04;
    dust.rotation.y = -t * 0.02;

    // Gentle bob on each phone.
    for (let i = 0; i < N; i++) {
      const bb = base[i]!;
      const bob = Math.sin(t * 1.3 + bb.phase) * 0.012;
      a.copy(bb.pos).multiplyScalar(1 + bob);
      m.compose(a, bb.quat, s);
      bodies.setMatrixAt(i, m);
      m.multiply(SCREEN_OFFSET);
      screens.setMatrixAt(i, m);
      flash[i] = Math.max(0, flash[i]! - dt * 1.4);
      col.copy(idle).lerp(ORANGE, Math.min(1, flash[i]!)).lerp(PEACH, Math.max(0, flash[i]! - 0.7));
      screens.setColorAt(i, col);
    }
    bodies.instanceMatrix.needsUpdate = true;
    screens.instanceMatrix.needsUpdate = true;
    if (screens.instanceColor) screens.instanceColor.needsUpdate = true;

    for (const p of pulses) {
      if (motion) p.t += dt * p.speed;
      if (p.t >= 1) {
        p.t = 0;
        if (!p.back) flash[p.dev] = 1.25; // task arrived: the screen lights up while it works
        p.back = !p.back;
        if (!p.back) p.dev = Math.floor(Math.random() * N);
        (p.sprite.material as THREE.SpriteMaterial).color.copy(p.back ? ORANGE : PEACH);
      }
      const dev = base[p.dev]!.pos;
      a.copy(dev).multiplyScalar(0.22);
      b.copy(dev).multiplyScalar(0.97);
      const e = p.t * p.t * (3 - 2 * p.t);
      if (p.back) p.sprite.position.lerpVectors(b, a, e);
      else p.sprite.position.lerpVectors(a, b, e);
      p.sprite.scale.setScalar(0.12 + Math.sin(p.t * Math.PI) * 0.14);
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
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      glowTex.dispose();
      screenTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
