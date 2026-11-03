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

const ORANGE = new THREE.Color("#f07843");
const PEACH = new THREE.Color("#fbe0cf");
const CHARCOAL = new THREE.Color("#2e2f35");

function fibonacciSphere(n: number, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
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

export function createConstellation(canvas: HTMLCanvasElement, opts: { motion: boolean; compact: boolean }): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.compact ? 1.5 : 1.75));
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
  const coreMat = new THREE.MeshPhysicalMaterial({ color: ORANGE, emissive: ORANGE, emissiveIntensity: 0.55, metalness: 0.2, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.1, flatShading: true });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0), coreMat);
  world.add(core);
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.0, 1)), new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.35 }));
  world.add(shell);
  const glowTex = glowTexture();
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: ORANGE, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreGlow.scale.setScalar(3.6);
  world.add(coreGlow);

  // Orbit rings.
  const ringMat = new THREE.MeshBasicMaterial({ color: PEACH, transparent: true, opacity: 0.18 });
  const rings: THREE.Mesh[] = [];
  for (const [rx, rz, r] of [[1.25, 0.2, 3.3], [1.75, -0.5, 3.9]] as const) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 6, 180), ringMat);
    ring.rotation.set(rx, 0, rz);
    world.add(ring);
    rings.push(ring);
  }

  // Phones: instanced bodies with instanced emissive screens.
  const N = opts.compact ? 34 : 56;
  const positions = fibonacciSphere(N, 3.1);
  const bodyGeo = new RoundedBoxGeometry(0.34, 0.66, 0.06, 4, 0.06);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: CHARCOAL, metalness: 0.7, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, N);
  const screenGeo = new THREE.PlaneGeometry(0.28, 0.58);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const screens = new THREE.InstancedMesh(screenGeo, screenMat, N);
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3(1, 1, 1);
  const tmp = new THREE.Object3D();
  const SCREEN_OFFSET = new THREE.Matrix4().makeTranslation(0, 0, 0.032);
  const base: { pos: THREE.Vector3; quat: THREE.Quaternion; phase: number }[] = [];
  positions.forEach((p, i) => {
    tmp.position.copy(p);
    tmp.lookAt(0, 0, 0);
    tmp.rotateY(Math.PI); // screen faces outward
    tmp.rotateZ((Math.random() - 0.5) * 0.5);
    tmp.updateMatrix();
    base.push({ pos: p.clone(), quat: tmp.quaternion.clone(), phase: Math.random() * Math.PI * 2 });
    bodies.setMatrixAt(i, tmp.matrix);
    m.compose(p, tmp.quaternion, s).multiply(SCREEN_OFFSET);
    screens.setMatrixAt(i, m);
    screens.setColorAt(i, new THREE.Color("#3a3b41"));
  });
  world.add(bodies, screens);

  // Links from each device to the core.
  const linkPos = new Float32Array(N * 6);
  positions.forEach((p, i) => linkPos.set([p.x * 0.97, p.y * 0.97, p.z * 0.97, p.x * 0.22, p.y * 0.22, p.z * 0.22], i * 6));
  const linkGeo = new THREE.BufferGeometry();
  linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPos, 3));
  const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }));
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
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: PEACH, size: 0.025, transparent: true, opacity: 0.55, depthWrite: false }));
  world.add(dust);

  // Pulses travelling along links: out (task, peach) then back (result, orange).
  interface Pulse { sprite: THREE.Sprite; dev: number; t: number; speed: number; back: boolean }
  const pulses: Pulse[] = [];
  const P = opts.compact ? 10 : 18;
  for (let i = 0; i < P; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: PEACH, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sprite.scale.setScalar(0.28);
    world.add(sprite);
    pulses.push({ sprite, dev: Math.floor(Math.random() * N), t: Math.random(), speed: 0.35 + Math.random() * 0.35, back: Math.random() > 0.5 });
  }
  const flash = new Float32Array(N);
  const idle = new THREE.Color("#3a3b41");
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
    camera.position.z = w / h < 0.9 ? 11.5 : 9.2;
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
    coreGlow.material.opacity = 0.7 + Math.sin(t * 2.2) * 0.12;
    rings[0]!.rotation.z = 0.2 + t * 0.05;
    rings[1]!.rotation.z = -0.5 - t * 0.04;
    dust.rotation.y = -t * 0.02;

    // Gentle bob on each phone.
    for (let i = 0; i < N; i++) {
      const bb = base[i]!;
      const bob = Math.sin(t * 1.3 + bb.phase) * 0.05;
      a.copy(bb.pos).multiplyScalar(1 + bob * 0.3);
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
      p.sprite.scale.setScalar(0.18 + Math.sin(p.t * Math.PI) * 0.18);
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
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
