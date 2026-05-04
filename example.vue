<template>
  <div class="lab-scene">
    <canvas ref="canvas" class="lab-scene__canvas" />
    <NuxtLink to="/lab" class="lab-scene__back">← Back</NuxtLink>
  </div>
</template>

<script setup>
  import * as THREE from 'three';
  import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
  import GUI from 'lil-gui';
  import Stats from 'stats.js';

  definePageMeta({ layout: 'lab' });

  const canvas = ref(null);

  const TWO_PI = Math.PI * 2;
  const DEG2RAD = Math.PI / 180;

  // Параметры. Ключевые отличия от v1:
  //  - pitch фиксирован (нет pitchSway): гарантирует axial-зазор между витками.
  //  - drift.x = 0 (дрейф только в YZ): не сжимает этот зазор во времени.
  //  - tilt(ti) применяется ПОКАДРОВО КАЖДОМУ СЕГМЕНТУ в момент его рождения,
  //    а не ко всему мешу как твёрдому телу. История направлений «запекается»
  //    в ленту: голова сейчас имеет tilt(t), хвост — tilt(t-Lag). Направление
  //    намотки у головы реально меняется; лента не просто крутится целиком.
  //  - camera и drift — хаотичные hash-таргеты со smoothstep, не sum-of-sines.
  //
  // pitch=0.55 — заметно больше v1 (0.18): ширина зазора между витками должна
  // выдержать поворот головы и хвоста на разные углы (до 2·tiltMax в экстремуме).
  // При малом pitch лента в фазе противоположных tilt'ов сходится с хвостом.
  const state = {
    radius: 1.0,
    radial: 0.08,
    axial: 0.2,
    pitch: 0.55,

    orbitPeriod: 2.2,
    ribbonLagSec: 2.2,
    driftAmp: 0.1,

    tiltMaxDeg: 40,
    tiltPeriod: 2.0,

    camYawBaseDeg: 25,
    camYawAmpDeg: 6,
    camYawPeriod: 3.0,

    color: '#1e3a8a',
    metalness: 0.88,
    roughness: 0.24,

    envIntensity: 1.1,
    ambientIntensity: 0.45,
    keyLightIntensity: 1.3,
  };

  const CAM_DIST = 1.08 / Math.tan(20 * DEG2RAD);
  const initYaw = state.camYawBaseDeg * DEG2RAD;

  const { scene, camera, renderer, onTick } = useScene(canvas, {
    fov: 40,
    cameraPosition: [CAM_DIST * Math.sin(initYaw), 0, CAM_DIST * Math.cos(initYaw)],
    clearColor: 0xffffff,
  });

  let gui;
  let stats;

  // Топология: 4 длинных лица без шаринга вершин (острые рёбра сечения) + 2 cap'а.
  //   [0..2(N+1))         → F01 (top):     A=C0, B=C1
  //   [2(N+1)..4(N+1))    → F12 (axial−):  A=C1, B=C2
  //   [4(N+1)..6(N+1))    → F23 (bottom):  A=C2, B=C3
  //   [6(N+1)..8(N+1))    → F30 (axial+):  A=C3, B=C0
  //   +8 вершин на cap'ы торцов.
  const N = 200;
  const LFV = (N + 1) * 2;
  const CAP_BASE = 4 * LFV;
  const TOTAL_VERTS = CAP_BASE + 8;

  // Murmur-style integer finalizer. Заменяет fract(sin(...)*big) — тот даёт
  // скрытые корреляции на целых n, глаз читает их как «строгое чередование».
  const hash32 = (seed) => {
    let x = seed | 0;
    x = Math.imul(x ^ (x >>> 16), 2246822507);
    x = Math.imul(x ^ (x >>> 13), 3266489909);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };

  // Helix: ось = +X, окружность в YZ. Pitch строго линейный по углу.
  // Никакого pitchAt(t)·t/T: любая модуляция pitch, умноженная на растущее t,
  // через десятки секунд превращает ленту в «растянутого мутанта».
  const helixAt = (t, out) => {
    const theta = (TWO_PI / state.orbitPeriod) * t;
    out.x = (state.pitch * theta) / TWO_PI;
    out.y = state.radius * Math.cos(theta);
    out.z = state.radius * Math.sin(theta);
  };

  // Per-orbit drift target. Направление — единичный 2D-вектор в YZ, амплитуда ∈ [0.2..1.0].
  // X занулён принципиально: если drift.x ≠ 0, он в моменте сжимает axial-gap между
  // головой и хвостом → риск пересечения «началом-концом». Убирая его, мы фиксируем
  // axial-зазор = pitch·(Lag/T) − axial ровно на все времена.
  const pickDriftTarget = (n, out) => {
    const hy = hash32(n * 5 + 0x9e3779b1);
    const hz = hash32(n * 5 + 0x243f6a88);
    const ha = hash32(n * 5 + 0xb7e15162);
    const dy = hy * 2 - 1;
    const dz = hz * 2 - 1;
    const len = Math.sqrt(dy * dy + dz * dz) || 1;
    const amp = (0.2 + 0.8 * ha) / len;
    out.x = 0;
    out.y = dy * amp;
    out.z = dz * amp;
  };

  const tgt0 = new THREE.Vector3();
  const tgt1 = new THREE.Vector3();
  const tgt2 = new THREE.Vector3();
  const tgt3 = new THREE.Vector3();

  // Catmull-Rom (τ=0.5) через таргеты предыдущего/текущего/следующих двух оборотов.
  // C1-гладкий сплайн с ненулевой касательной в узлах → голова не тормозит на таргетах,
  // но каждый оборот — чёткая «точка смены направления».
  const driftAt = (t, out) => {
    const A = state.driftAmp * state.radius;
    const phase = t / state.orbitPeriod;
    const n = Math.floor(phase);
    const u = phase - n;
    pickDriftTarget(n - 1, tgt0);
    pickDriftTarget(n, tgt1);
    pickDriftTarget(n + 1, tgt2);
    pickDriftTarget(n + 2, tgt3);
    const u2 = u * u;
    const u3 = u2 * u;
    const c0 = -0.5 * u + u2 - 0.5 * u3;
    const c1 = 1 - 2.5 * u2 + 1.5 * u3;
    const c2 = 0.5 * u + 2 * u2 - 1.5 * u3;
    const c3 = -0.5 * u2 + 0.5 * u3;
    out.x = 0;
    out.y = A * (c0 * tgt0.y + c1 * tgt1.y + c2 * tgt2.y + c3 * tgt3.y);
    // z с весом 0.8 — с yaw-камеры глубина слабее считывается, экономим амплитуду.
    out.z = A * 0.8 * (c0 * tgt0.z + c1 * tgt1.z + c2 * tgt2.z + c3 * tgt3.z);
  };

  // Тилт оси helix вокруг Z. Хаотичные uniform-таргеты ∈ [−tiltMax..+tiltMax],
  // smoothstep между ними: плавный переход, КРАТКАЯ задержка на целевом угле
  // (производная = 0 в узлах). Каждые tiltPeriod секунд — новый таргет.
  // tiltPeriod < orbitPeriod → смена направления чаще, чем полный оборот головы.
  const pickAngle = (n, seedBase, ampDeg) => {
    const h = hash32(n + seedBase);
    return ampDeg * DEG2RAD * (h * 2 - 1);
  };
  const tiltAt = (t) => {
    const phase = t / state.tiltPeriod;
    const n = Math.floor(phase);
    const u = phase - n;
    const a1 = pickAngle(n * 7, 0x7f4a7c13, state.tiltMaxDeg);
    const a2 = pickAngle((n + 1) * 7, 0x7f4a7c13, state.tiltMaxDeg);
    const e = u * u * (3 - 2 * u);
    return a1 + (a2 - a1) * e;
  };

  // Камера — тот же хаос, меньшая амплитуда. Всегда Y=0, lookAt(0,0,0) → tilt
  // не появляется (roll/pitch никогда не возникают).
  const camYawAt = (t) => {
    const phase = t / state.camYawPeriod;
    const n = Math.floor(phase);
    const u = phase - n;
    const a1 = pickAngle(n * 11, 0x51a1c4d7, state.camYawAmpDeg);
    const a2 = pickAngle((n + 1) * 11, 0x51a1c4d7, state.camYawAmpDeg);
    const e = u * u * (3 - 2 * u);
    return state.camYawBaseDeg * DEG2RAD + a1 + (a2 - a1) * e;
  };

  // Центры сегментов и per-segment frame (cos/sin tilt + cos/sin theta).
  // Frame нужен для построения сечения во втором проходе — храним отдельно,
  // чтобы не пересчитывать sin/cos дважды и не аллоцировать покадрово.
  const centers = Array.from({ length: N + 1 }, () => new THREE.Vector3());
  const framesCa = new Float64Array(N + 1); // cos(tilt(ti))
  const framesSa = new Float64Array(N + 1); // sin(tilt(ti))
  const framesRlY = new Float64Array(N + 1); // cos(theta) — unit radial.y в local
  const framesRlZ = new Float64Array(N + 1); // sin(theta) — unit radial.z в local
  const driftTmp = new THREE.Vector3();

  // Индексы строятся один раз (топология фиксирована, меняются только позиции).
  const buildIndices = () => {
    const idx = [];
    for (let f = 0; f < 4; f++) {
      const base = f * LFV;
      for (let k = 0; k < N; k++) {
        const Ak = base + k;
        const Akk = base + k + 1;
        const Bk = base + (N + 1) + k;
        const Bkk = base + (N + 1) + k + 1;
        idx.push(Ak, Bkk, Bk, Ak, Akk, Bkk);
      }
    }
    // Head-cap (i=0): outward ≈ +velocity, CCW (C0,C1,C2)(C0,C2,C3).
    const h = CAP_BASE;
    idx.push(h, h + 1, h + 2, h, h + 2, h + 3);
    // Tail-cap (i=N): outward ≈ −velocity, обратная намотка.
    const tl = CAP_BASE + 4;
    idx.push(tl, tl + 2, tl + 1, tl, tl + 3, tl + 2);
    return idx;
  };

  // body(s, t): каждый сегмент рождается в момент ti = t − s·Lag со СВОИМ tilt(ti).
  // Локальный helix в (ось X, окружность в YZ), потом поворачивается вокруг Z на tilt(ti).
  // Это делает ось helix КРИВОЙ во времени: голова сейчас наклонена на tilt(t),
  // а хвост «помнит» tilt(t−Lag) — направление намотки у головы реально меняется,
  // лента не просто крутится целиком.
  //
  // drift — аддитивно в world YZ с taper'ом (1−s)² (голова получает полный,
  // хвост = 0). drift.x = 0: не сжимает axial-зазор между витками.
  //
  // Frame сечения тоже rotated-per-segment: axial_world = Rz(α)·(1,0,0),
  // radial_world = Rz(α)·(0, cos θ, sin θ). Сечение остаётся перпендикулярно
  // ЛОКАЛЬНОЙ (повёрнутой) оси helix — толщина ленты на экране стабильна.
  const updateGeometry = (t, positionAttr) => {
    const Lag = state.ribbonLagSec;
    const aH = state.axial * 0.5;
    const rH = state.radial * 0.5;
    const TP = TWO_PI / state.orbitPeriod;
    const pitchCoef = state.pitch / TWO_PI;
    const R = state.radius;

    // Pass 1: считаем центры и сохраняем frame. Суммы — для якоря (см. ниже).
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const ti = t - s * Lag;
      const theta = TP * ti;
      const clT = Math.cos(theta);
      const slT = Math.sin(theta);

      // Локальный helix
      const lx = pitchCoef * theta;
      const ly = R * clT;
      const lz = R * slT;

      // Per-segment tilt(ti) вокруг Z
      const alpha = tiltAt(ti);
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);

      // Rz(α) · (lx, ly, lz)
      const wx = lx * ca - ly * sa;
      const wy = lx * sa + ly * ca;
      const wz = lz;

      // Drift в world YZ (x=0 — см. комментарий к pickDriftTarget)
      driftAt(ti, driftTmp);
      const u = 1 - s;
      const dw = u * u;
      const fx = wx;
      const fy = wy + driftTmp.y * dw;
      const fz = wz + driftTmp.z * dw;

      centers[i].set(fx, fy, fz);
      sumX += fx;
      sumY += fy;
      sumZ += fz;

      framesCa[i] = ca;
      framesSa[i] = sa;
      framesRlY[i] = clT;
      framesRlZ[i] = slT;
    }

    // Anchor: вычитаем среднее world-положение по всем трём осям. Без per-segment tilt
    // было достаточно якорить только X (helix.y/z периодичны → среднее ~ 0). Теперь
    // rotated lx подмешивается в world Y, и среднее Y тоже ненулевое в моменте.
    // Якорим всё, чтобы фигура оставалась в центре кадра.
    const mx = sumX / (N + 1);
    const my = sumY / (N + 1);
    const mz = sumZ / (N + 1);
    for (let i = 0; i <= N; i++) {
      centers[i].x -= mx;
      centers[i].y -= my;
      centers[i].z -= mz;
    }

    // Pass 2: строим 4 угла сечения на каждом сегменте в повёрнутом frame.
    const pos = positionAttr.array;
    for (let i = 0; i <= N; i++) {
      const c = centers[i];
      const ca = framesCa[i];
      const sa = framesSa[i];
      const rlY = framesRlY[i];
      const rlZ = framesRlZ[i];

      // axial_world = Rz(α)·(1,0,0) = (cos α, sin α, 0)
      const axHx = ca * aH;
      const axHy = sa * aH;
      // axHz = 0

      // radial_world = Rz(α)·(0, cos θ, sin θ) = (−cos θ·sin α, cos θ·cos α, sin θ)
      const raHx = -rlY * sa * rH;
      const raHy = rlY * ca * rH;
      const raHz = rlZ * rH;

      // C0 = c + axial + radial,  C1 = c − axial + radial
      // C2 = c − axial − radial,  C3 = c + axial − radial
      const c0x = c.x + axHx + raHx;
      const c0y = c.y + axHy + raHy;
      const c0z = c.z + raHz;

      const c1x = c.x - axHx + raHx;
      const c1y = c.y - axHy + raHy;
      const c1z = c.z + raHz;

      const c2x = c.x - axHx - raHx;
      const c2y = c.y - axHy - raHy;
      const c2z = c.z - raHz;

      const c3x = c.x + axHx - raHx;
      const c3y = c.y + axHy - raHy;
      const c3z = c.z - raHz;

      // F01 (радиальная+ / "top"): A=C0, B=C1
      let p = i * 3;
      pos[p] = c0x;
      pos[p + 1] = c0y;
      pos[p + 2] = c0z;
      p = (i + N + 1) * 3;
      pos[p] = c1x;
      pos[p + 1] = c1y;
      pos[p + 2] = c1z;

      // F12 (axial−): A=C1, B=C2
      p = (LFV + i) * 3;
      pos[p] = c1x;
      pos[p + 1] = c1y;
      pos[p + 2] = c1z;
      p = (LFV + i + N + 1) * 3;
      pos[p] = c2x;
      pos[p + 1] = c2y;
      pos[p + 2] = c2z;

      // F23 (радиальная− / "bottom"): A=C2, B=C3
      p = (2 * LFV + i) * 3;
      pos[p] = c2x;
      pos[p + 1] = c2y;
      pos[p + 2] = c2z;
      p = (2 * LFV + i + N + 1) * 3;
      pos[p] = c3x;
      pos[p + 1] = c3y;
      pos[p + 2] = c3z;

      // F30 (axial+): A=C3, B=C0
      p = (3 * LFV + i) * 3;
      pos[p] = c3x;
      pos[p + 1] = c3y;
      pos[p + 2] = c3z;
      p = (3 * LFV + i + N + 1) * 3;
      pos[p] = c0x;
      pos[p + 1] = c0y;
      pos[p + 2] = c0z;

      if (i === 0) {
        const b = CAP_BASE * 3;
        pos[b] = c0x;
        pos[b + 1] = c0y;
        pos[b + 2] = c0z;
        pos[b + 3] = c1x;
        pos[b + 4] = c1y;
        pos[b + 5] = c1z;
        pos[b + 6] = c2x;
        pos[b + 7] = c2y;
        pos[b + 8] = c2z;
        pos[b + 9] = c3x;
        pos[b + 10] = c3y;
        pos[b + 11] = c3z;
      } else if (i === N) {
        const b = (CAP_BASE + 4) * 3;
        pos[b] = c0x;
        pos[b + 1] = c0y;
        pos[b + 2] = c0z;
        pos[b + 3] = c1x;
        pos[b + 4] = c1y;
        pos[b + 5] = c1z;
        pos[b + 6] = c2x;
        pos[b + 7] = c2y;
        pos[b + 8] = c2z;
        pos[b + 9] = c3x;
        pos[b + 10] = c3y;
        pos[b + 11] = c3z;
      }
    }
    positionAttr.needsUpdate = true;
  };

  onMounted(() => {
    // Procedural env через RoomEnvironment. Без env на белом фоне металл читается
    // как пластик — отражать нечего.
    const pmrem = new THREE.PMREMGenerator(renderer.value);
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.value.environment = envMap;
    scene.value.environmentIntensity = state.envIntensity;
    pmrem.dispose();

    const ambient = new THREE.AmbientLight(0xffffff, state.ambientIntensity);
    scene.value.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, state.keyLightIntensity);
    keyLight.position.set(2, 2.5, 3);
    scene.value.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xcfd6ff, 0.5);
    fillLight.position.set(-2, -1.2, 2.2);
    scene.value.add(fillLight);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(TOTAL_VERTS * 3);
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttr);
    geometry.setIndex(buildIndices());

    const material = new THREE.MeshStandardMaterial({
      color: state.color,
      metalness: state.metalness,
      roughness: state.roughness,
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.value.add(mesh);

    // Стартуем в установившемся режиме — все функции аналитические, warm-up не нужен.
    updateGeometry(0, positionAttr);
    geometry.computeVertexNormals();
    // Bounding sphere щедрая: ribbon гуляет в пределах R + drift + tilt.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3);

    onTick((_dt, elapsed) => {
      // tilt применяется ПОКАДРОВО-ПО-СЕГМЕНТУ внутри updateGeometry, поэтому
      // mesh.rotation здесь НЕ крутим — иначе наложили бы глобальный поворот
      // поверх per-segment поворотов и опять получили бы «крутится целиком».
      updateGeometry(elapsed, positionAttr);
      geometry.computeVertexNormals();

      const yaw = camYawAt(elapsed);
      camera.value.position.set(CAM_DIST * Math.sin(yaw), 0, CAM_DIST * Math.cos(yaw));
      camera.value.lookAt(0, 0, 0);
    });

    gui = new GUI({ title: 'Metal Ribbon Loop 2' });

    const fShape = gui.addFolder('форма');
    fShape.add(state, 'radius', 0.3, 1.4, 0.01);
    fShape.add(state, 'radial', 0.02, 0.3, 0.005);
    fShape.add(state, 'axial', 0.05, 0.45, 0.005);
    fShape.add(state, 'pitch', 0.35, 0.9, 0.005).name('pitch (fixed)');

    const fMotion = gui.addFolder('движение');
    fMotion.add(state, 'orbitPeriod', 0.8, 6, 0.05).name('orbit period (s)');
    fMotion.add(state, 'ribbonLagSec', 0.8, 5, 0.05).name('ribbon lag (s)');
    fMotion.add(state, 'driftAmp', 0, 0.5, 0.005).name('drift amp');
    fMotion.add(state, 'tiltMaxDeg', 0, 45, 0.5).name('tilt max (deg)');
    fMotion.add(state, 'tiltPeriod', 0.8, 6, 0.05).name('tilt period (s)');

    const fCam = gui.addFolder('камера');
    fCam.add(state, 'camYawBaseDeg', 0, 60, 0.5).name('yaw base (deg)');
    fCam.add(state, 'camYawAmpDeg', 0, 15, 0.5).name('yaw pan (deg)');
    fCam.add(state, 'camYawPeriod', 1.5, 8, 0.1).name('yaw period (s)');

    const fMat = gui.addFolder('материал');
    fMat.addColor(state, 'color').onChange((v) => material.color.set(v));
    fMat.add(state, 'metalness', 0, 1, 0.01).onChange((v) => {
      material.metalness = v;
    });
    fMat.add(state, 'roughness', 0, 1, 0.01).onChange((v) => {
      material.roughness = v;
    });

    const fLight = gui.addFolder('свет');
    fLight.add(state, 'envIntensity', 0, 2, 0.01).onChange((v) => {
      scene.value.environmentIntensity = v;
    });
    fLight.add(state, 'ambientIntensity', 0, 1.5, 0.01).onChange((v) => {
      ambient.intensity = v;
    });
    fLight.add(state, 'keyLightIntensity', 0, 3, 0.01).onChange((v) => {
      keyLight.intensity = v;
    });

    stats = new Stats();
    stats.dom.style.position = 'fixed';
    stats.dom.style.top = '0';
    stats.dom.style.left = '0';
    document.body.appendChild(stats.dom);
    onTick(() => stats.update());
  });

  onBeforeUnmount(() => {
    gui?.destroy();
    stats?.dom?.remove();
  });
</script>

<style lang="scss" scoped>
  .lab-scene {
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;

    &__canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    &__back {
      position: absolute;
      top: 16px;
      right: 16px;
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.5);
      color: #fff;
      text-decoration: none;
      border-radius: 6px;
      font-size: 13px;
      backdrop-filter: blur(10px);
      z-index: 10;
      transition: background 0.15s;

      &:hover {
        background: rgba(0, 0, 0, 0.7);
      }
    }
  }
</style>
