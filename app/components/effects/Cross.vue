<!--
  Магнитные кресты.
  16 трёхцветных крестов (cross.buf) толкутся вокруг малой невидимой сферы притяжения
  внутри блока 700×90vw. Кресты не пересекаются (soft-collision + PBD), постоянно
  обмениваются давлениями. Курсор-«флик» уносит крест за границу блока, силы тянут обратно.
  Бриф: briefs/cross.md
-->
<template>
  <div class="cross-stage">
    <canvas ref="canvas" class="cross-stage__canvas" />
  </div>
</template>

<script setup>
  import * as THREE from 'three';
  import GUI from 'lil-gui';
  // Та же модель, что в magnetic-nuts (cross.buf).
  import crossModelUrl from '~/assets/models/cross.buf?url';

  const canvas = ref(null);

  const { scene, camera, renderer, size, onTick, onResize } = useScene(canvas, {
    fov: 45,
    near: 0.1,
    far: 100,
    cameraPosition: [0, 0, 5],
    clearColor: 0x0a0b10,
  });

  const CROSS_COUNT = 16;
  // Целевой максимальный габарит креста после нормализации .buf-габаритов.
  // Подобрано визуально под кластер ≈3.5 world-units диаметра при 16 деталях.
  const CROSS_TARGET_SIZE = 1.1;

  // Простой seeded RNG (mulberry32). Нужен только для повторяемой раскладки цветов —
  // позиции/повороты/spin и так стохастичны от Math.random.
  function mulberry32(seed) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 16 крестов: 6 белых + 5 синих + 5 чёрных, перемешаны seeded shuffle.
  // Сид зашит — раскладка одинакова между релоадами.
  function buildColorPlan() {
    const rng = mulberry32(0xc30551);
    const counts = { white: 6, blue: 5, black: 5 };
    const arr = [];
    for (const k of Object.keys(counts)) {
      for (let i = 0; i < counts[k]; i++) arr.push(k);
    }
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  const COLOR_PLAN = buildColorPlan();

  // 5 матовых / 11 глянцевых (≈30/70). Матовые расставлены равномерно по индексам,
  // чтобы не группировались в одной части кластера.
  const MATERIAL_PLAN = (() => {
    const arr = new Array(CROSS_COUNT).fill('glossy');
    const matteCount = 5;
    for (let i = 0; i < matteCount; i++) {
      arr[Math.floor((i * CROSS_COUNT) / matteCount)] = 'matte';
    }
    return arr;
  })();

  const params = {
    crossScale: 0.8,
    // Плотная стартовая упаковка вокруг малой сферы.
    spawnRadius: 0.8,
    // Диаметр невидимой сферы притяжения в screen-px. Конвертируется в world-units каждый кадр.
    attractorScreenPx: 50,
    // Адаптивный FOV под форму контейнера (как в рефе HomeHeroSection):
    // широкий блок -> уже FOV (камера дальше), узкий -> шире.
    adaptiveFov: true,
    fovWideAspect: 2.2,
    fovNarrowAspect: 2 / 3,
    fovWide: 18,
    fovNarrow: 30,
    // Intro: scale(0->1) + twist по Z (180°->0) с staggered delay по индексу.
    // Кривая lusion-ease (exp-out). Длительность включает per-cross delay.
    introEnabled: true,
    introDuration: 0.6,
    introStaggerPerIndex: 0.1,
    introBaseDelay: 0.2,
    introRotationDeg: 180,
    centerPullStrength: 8.7,
    linearDamping: 0.85,
    collisionRadius: 1.0,
    collisionStiffness: 20.1,
    maxSpeed: 11.2,
    angularDamping: 0.76,
    maxAngularSpeed: 3.4,
    // На потолке диапазона — заметные закрутки от любого контакта.
    collisionAngularKick: 2,
    ambientSpinStrength: 0.026,
    // 0: все кресты ведут себя одинаково по угловой динамике — без per-cross «характера».
    spinFactorVariance: 0,
    colorWhite: '#c7c7c7',
    colorBlue: '#1030da',
    colorBlack: '#00000f',
    sceneBg: '#0a0b10',
    // Hemi выключен — оставлен в коде на случай, если захочется добавить мягкую заливку через GUI.
    hemiSkyColor: '#ffffff',
    hemiGroundColor: '#ffffff',
    hemiIntensity: 0,
    // Единственный активный источник света. Цвет/интенсивность/позиция регулируются из GUI.
    dirLightColor: '#e0e0e0',
    dirLightIntensity: 5,
    dirLightX: -6.5,
    dirLightY: -3,
    dirLightZ: 30,
    matteRoughness: 1,
    glossyRoughness: 0,
    screenHitPaddingPx: 60,
    pushStrength: 60,
    pushSpeedRef: 5,
    // Крутая нелинейность: медленное ведение почти не двигает кресты, флик — резко уносит.
    pushSpeedExp: 3,
    pushMaxFactor: 8,
    pushMinFactor: 0.06,
  };

  let crosses = []; // { mesh, velocity, omega, colorKey, materialKind, spinFactor, baseSphereRadius, physicsQuat }
  let sharedGeometry = null;
  let dirLight = null;
  let hemiLight = null;
  let gui = null;
  let introTime = 0;
  const COLOR_CYCLE = ['white', 'blue', 'black'];

  // Pointer state.
  let prevPointerCanvasX = 0;
  let prevPointerCanvasY = 0;
  let prevPointerTime = 0;
  let pointerMoveInited = false;

  // Reusables.
  const tmpVec = new THREE.Vector3();
  const tmpVec2 = new THREE.Vector3();
  const tmpProj = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpTwistQuat = new THREE.Quaternion();
  const AXIS_Z = new THREE.Vector3(0, 0, 1);

  // math.fit-аналог: линейная ремап с clamp на выходе.
  function fit(value, inMin, inMax, outMin, outMax) {
    const t = (value - inMin) / (inMax - inMin);
    const k = Math.max(0, Math.min(1, t));
    return outMin + (outMax - outMin) * k;
  }
  // Lusion-ease (exp-out) — мягкое торможение к концу, как в рефе.
  function easeLusion(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 1 - Math.pow(2, -10 * t);
  }

  function getColorHex(key) {
    if (key === 'white') return params.colorWhite;
    if (key === 'blue') return params.colorBlue;
    return params.colorBlack;
  }

  function randomInSphere(r, out) {
    let x, y, z;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    out.set(x * r, y * r, z * r);
  }

  function applyMaterialParams() {
    crosses.forEach(({ mesh, colorKey, materialKind }) => {
      mesh.material.color.set(getColorHex(colorKey));
      const isMatte = materialKind === 'matte';
      mesh.material.roughness = isMatte ? params.matteRoughness : params.glossyRoughness;
    });
  }

  function reseedSpinFactors() {
    const v = params.spinFactorVariance;
    crosses.forEach((n) => {
      n.spinFactor = 1 + (Math.random() * 2 - 1) * v;
    });
  }

  // Радиус сферы притяжения в world-units, пересчитан из screen-px по текущему FOV/distance/canvas-height.
  // Дёшево — считаем каждый шаг физики, на ресайз реагируем без отдельного хука.
  function getAttractorWorldRadius() {
    if (!size.height) return 0.15;
    const camZ = Math.abs(camera.value.position.z);
    const worldH = 2 * camZ * Math.tan((camera.value.fov * Math.PI) / 360);
    // attractorScreenPx — диаметр; делим на 2 для радиуса.
    return ((params.attractorScreenPx * 0.5) / size.height) * worldH;
  }

  // Парсер кастомного .buf: [uint32 LE — длина JSON][JSON-манифест][бинарные буферы атрибутов].
  // Описание формата — в magnetic-nuts.md и cross.md. Из манифеста читаем только position/normal/indices.
  const TYPE_INFO = {
    Float32Array: { ctor: Float32Array, bytes: 4, max: 1 },
    Uint16Array: { ctor: Uint16Array, bytes: 2, max: 65535 },
    Int16Array: { ctor: Int16Array, bytes: 2, max: 32767 },
    Uint8Array: { ctor: Uint8Array, bytes: 1, max: 255 },
  };

  async function loadBufGeometry(url) {
    const arrayBuffer = await (await fetch(url)).arrayBuffer();
    const headerLen = new DataView(arrayBuffer).getUint32(0, true);
    const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 4, headerLen)));
    const { vertexCount, indexCount, attributes } = manifest;

    let offset = 4 + headerLen;
    const parsed = {};
    for (const attr of attributes) {
      const info = TYPE_INFO[attr.storageType];
      if (!info) throw new Error(`[buf] неизвестный storageType: ${attr.storageType}`);
      const count = (attr.id === 'indices' ? indexCount : vertexCount) * attr.componentSize;
      const raw = new info.ctor(arrayBuffer, offset, count);
      offset += count * info.bytes;
      parsed[attr.id] = { attr, raw, info };
    }

    const geometry = new THREE.BufferGeometry();

    const posSrc = parsed.position;
    if (posSrc) {
      const { raw, attr, info } = posSrc;
      const out = new Float32Array(raw.length);
      if (attr.needsPack) {
        for (let i = 0; i < raw.length; i++) {
          const c = attr.packedComponents[i % attr.componentSize];
          out[i] = c.from + (raw[i] / info.max) * c.delta;
        }
      } else {
        out.set(raw);
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(out, attr.componentSize));
    }

    if (parsed.normal) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(parsed.normal.raw, parsed.normal.attr.componentSize));
    }

    if (parsed.indices) {
      geometry.setIndex(new THREE.BufferAttribute(parsed.indices.raw, 1));
    }

    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);
    const sz = new THREE.Vector3();
    geometry.boundingBox.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    const k = CROSS_TARGET_SIZE / maxDim;
    geometry.scale(k, k, k);
    geometry.computeBoundingSphere();
    if (!parsed.normal) geometry.computeVertexNormals();
    return geometry;
  }

  function createCrosses(geometry) {
    const baseRadius = geometry.boundingSphere.radius;
    for (let i = 0; i < CROSS_COUNT; i++) {
      const colorKey = COLOR_PLAN[i];
      const materialKind = MATERIAL_PLAN[i];
      const isMatte = materialKind === 'matte';
      const material = new THREE.MeshStandardMaterial({
        color: getColorHex(colorKey),
        roughness: isMatte ? params.matteRoughness : params.glossyRoughness,
        metalness: 0,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.setScalar(params.crossScale);

      const pos = new THREE.Vector3();
      randomInSphere(params.spawnRadius * CROSS_TARGET_SIZE, pos);
      mesh.position.copy(pos);
      const initialQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2)
      );
      mesh.quaternion.copy(initialQuat);
      // Стартовый scale=0 если intro включено: иначе виден до первого кадра composeTransforms.
      if (params.introEnabled) mesh.scale.setScalar(0);

      const v = params.spinFactorVariance;
      const spinFactor = 1 + (Math.random() * 2 - 1) * v;

      scene.value.add(mesh);
      crosses.push({
        mesh,
        velocity: new THREE.Vector3(),
        omega: new THREE.Vector3(),
        colorKey,
        materialKind,
        spinFactor,
        baseSphereRadius: baseRadius,
        physicsQuat: initialQuat.clone(),
      });
    }
  }

  function setupLights() {
    hemiLight = new THREE.HemisphereLight(params.hemiSkyColor, params.hemiGroundColor, params.hemiIntensity);
    dirLight = new THREE.DirectionalLight(params.dirLightColor, params.dirLightIntensity);
    dirLight.position.set(params.dirLightX, params.dirLightY, params.dirLightZ);
    scene.value.add(hemiLight, dirLight);
  }

  function dampingFactor(perFrame, dt) {
    return Math.pow(perFrame, dt * 60);
  }

  // Шаг физики. Pull-to-attractor-sphere (а не к точке) + soft-collision + PBD + угловая интеграция.
  function physicsStep(dt) {
    const k = params.centerPullStrength;
    const cStiff = params.collisionStiffness;
    const cFactor = params.collisionRadius;
    const maxV = params.maxSpeed;
    const maxAng = params.maxAngularSpeed;
    const dampLin = dampingFactor(params.linearDamping, dt);
    const dampAng = dampingFactor(params.angularDamping, dt);
    const ar = getAttractorWorldRadius();

    const forces = crosses.map(() => new THREE.Vector3());
    const angKicks = crosses.map(() => new THREE.Vector3());

    for (let i = 0; i < crosses.length; i++) {
      const ni = crosses[i];
      // Pull только если центр меша снаружи малой сферы. Внутри — нулевая сила.
      // F = -k · (p - clampToSphere(p, ar)). Эквивалентно: -k · p · overshoot/dist.
      const dist = ni.mesh.position.length();
      if (dist > ar && dist > 1e-6) {
        const overshoot = dist - ar;
        forces[i].addScaledVector(ni.mesh.position, (-k * overshoot) / dist);
      }
      const ri = ni.baseSphereRadius * ni.mesh.scale.x * cFactor;

      for (let j = i + 1; j < crosses.length; j++) {
        const nj = crosses[j];
        tmpVec.subVectors(ni.mesh.position, nj.mesh.position);
        const d = tmpVec.length();
        const minD = ri + nj.baseSphereRadius * nj.mesh.scale.x * cFactor;
        if (d < minD && d > 1e-6) {
          const pen = minD - d;
          tmpVec.multiplyScalar(1 / d);
          const fmag = pen * cStiff;
          forces[i].addScaledVector(tmpVec, fmag);
          forces[j].addScaledVector(tmpVec, -fmag);

          tmpVec2.subVectors(ni.velocity, nj.velocity);
          const vTan = tmpVec2.dot(tmpVec);
          tmpVec2.addScaledVector(tmpVec, -vTan);
          const tlen = tmpVec2.length();
          if (tlen > 1e-6) {
            tmpVec2.multiplyScalar(1 / tlen);
            tmpProj.crossVectors(tmpVec, tmpVec2);
            const kick = (pen + tlen * 0.15) * params.collisionAngularKick;
            angKicks[i].addScaledVector(tmpProj, kick * ni.spinFactor);
            angKicks[j].addScaledVector(tmpProj, -kick * nj.spinFactor);
          }
        }
      }
    }

    const ambientSpin = params.ambientSpinStrength * Math.sqrt(dt * 60);
    for (let i = 0; i < crosses.length; i++) {
      const ni = crosses[i];
      ni.velocity.addScaledVector(forces[i], dt);
      ni.velocity.multiplyScalar(dampLin);
      const sp = ni.velocity.length();
      if (sp > maxV) ni.velocity.multiplyScalar(maxV / sp);
      ni.mesh.position.addScaledVector(ni.velocity, dt);

      ni.omega.add(angKicks[i]);
      const a = ambientSpin * ni.spinFactor;
      ni.omega.x += (Math.random() * 2 - 1) * a;
      ni.omega.y += (Math.random() * 2 - 1) * a;
      ni.omega.z += (Math.random() * 2 - 1) * a;
      ni.omega.multiplyScalar(dampAng);
      const angSp = ni.omega.length();
      if (angSp > maxAng) ni.omega.multiplyScalar(maxAng / angSp);

      // Интегрируем чистый physicsQuat — финальный mesh.quaternion композируется в composeTransforms
      // (с учётом intro-twist'а). Если писать сразу в mesh.quaternion, twist дрейфит physics.
      tmpQuat.set(ni.omega.x, ni.omega.y, ni.omega.z, 0).multiply(ni.physicsQuat);
      ni.physicsQuat.x += 0.5 * tmpQuat.x * dt;
      ni.physicsQuat.y += 0.5 * tmpQuat.y * dt;
      ni.physicsQuat.z += 0.5 * tmpQuat.z * dt;
      ni.physicsQuat.w += 0.5 * tmpQuat.w * dt;
      ni.physicsQuat.normalize();
    }

    // PBD post-correction — гарантирует, что кресты не пересекаются визуально
    // даже при сильном курсорном флике через кластер.
    for (let i = 0; i < crosses.length; i++) {
      const ni = crosses[i];
      const ri = ni.baseSphereRadius * ni.mesh.scale.x * cFactor;
      for (let j = i + 1; j < crosses.length; j++) {
        const nj = crosses[j];
        tmpVec.subVectors(ni.mesh.position, nj.mesh.position);
        const d = tmpVec.length();
        const minD = ri + nj.baseSphereRadius * nj.mesh.scale.x * cFactor;
        if (d < minD && d > 1e-6) {
          const half = (minD - d) * 0.5;
          tmpVec.multiplyScalar(half / d);
          ni.mesh.position.add(tmpVec);
          nj.mesh.position.sub(tmpVec);
        }
      }
    }
  }

  // Adaptive FOV под форму контейнера (как в HomeHeroSection-рефе):
  // широкий блок (aspect>=2.2) -> fov=18, узкий (aspect<=2/3) -> fov=30.
  function applyAdaptiveFov() {
    if (!params.adaptiveFov || !camera.value || !size.width || !size.height) return;
    const aspect = size.width / size.height;
    const newFov = fit(aspect, params.fovWideAspect, params.fovNarrowAspect, params.fovWide, params.fovNarrow);
    if (Math.abs(newFov - camera.value.fov) > 1e-3) {
      camera.value.fov = newFov;
      camera.value.updateProjectionMatrix();
    }
  }

  // Click по холсту -> сдвиг палитры (white -> blue -> black -> white) у каждого креста.
  // Детерминированно: 3 клика возвращают исходную раскладку.
  function cyclePalette() {
    for (const c of crosses) {
      const idx = COLOR_CYCLE.indexOf(c.colorKey);
      c.colorKey = COLOR_CYCLE[(idx + 1) % COLOR_CYCLE.length];
    }
    applyMaterialParams();
  }
  function handleCanvasClick() {
    cyclePalette();
  }

  // Финальная сборка mesh.transform на каждом кадре:
  // - scale = crossScale * introScale (lusion-ease 0..1)
  // - quaternion = physicsQuat ∘ twistZ((1-introK) * introRotation)
  // Когда intro заканчивается, twist -> identity и mesh.quaternion = physicsQuat.
  function composeTransforms() {
    const introOn = params.introEnabled;
    for (let i = 0; i < crosses.length; i++) {
      const ni = crosses[i];
      let introK = 1;
      if (introOn) {
        const t = (introTime - params.introBaseDelay - i * params.introStaggerPerIndex) / Math.max(1e-3, params.introDuration);
        introK = easeLusion(Math.max(0, Math.min(1, t)));
      }
      ni.mesh.scale.setScalar(params.crossScale * introK);
      const rot = (1 - introK) * params.introRotationDeg * (Math.PI / 180);
      if (rot > 1e-5) {
        tmpTwistQuat.setFromAxisAngle(AXIS_Z, rot);
        ni.mesh.quaternion.multiplyQuaternions(ni.physicsQuat, tmpTwistQuat);
      } else {
        ni.mesh.quaternion.copy(ni.physicsQuat);
      }
    }
  }

  function applyCursorPush(canvasX, canvasY, dxPx, dyPx, speedPxPerMs) {
    if (!size.width || !size.height) return;
    const halfW = size.width / 2;
    const halfH = size.height / 2;
    const cursorPxX = canvasX - halfW;
    const cursorPxY = halfH - canvasY;

    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < crosses.length; i++) {
      const ni = crosses[i];
      tmpProj.copy(ni.mesh.position).project(camera.value);
      const screenPxX = tmpProj.x * halfW;
      const screenPxY = tmpProj.y * halfH;

      const distFromCam = Math.abs(camera.value.position.z - ni.mesh.position.z);
      const worldH = 2 * distFromCam * Math.tan((camera.value.fov * Math.PI) / 360);
      const worldRadius = ni.baseSphereRadius * ni.mesh.scale.x;
      const radiusPx = (worldRadius / worldH) * size.height;

      const dx = screenPxX - cursorPxX;
      const dy = screenPxY - cursorPxY;
      const dist = Math.hypot(dx, dy);
      const threshold = radiusPx + params.screenHitPaddingPx;
      if (dist < threshold && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) return;

    const len = Math.hypot(dxPx, dyPx);
    if (len < 0.5) return;
    const nx = dxPx / len;
    const ny = -dyPx / len;
    const ratio = speedPxPerMs / params.pushSpeedRef;
    const factor = Math.min(params.pushMaxFactor, Math.max(params.pushMinFactor, Math.pow(ratio, params.pushSpeedExp)));
    const impulse = params.pushStrength * factor;
    crosses[bestIdx].velocity.x += nx * impulse;
    crosses[bestIdx].velocity.y += ny * impulse;
  }

  function handlePointerMove(e) {
    const rect = canvas.value.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const now = performance.now();
    if (!pointerMoveInited) {
      prevPointerCanvasX = cx;
      prevPointerCanvasY = cy;
      prevPointerTime = now;
      pointerMoveInited = true;
      return;
    }
    const dx = cx - prevPointerCanvasX;
    const dy = cy - prevPointerCanvasY;
    const dtMs = Math.max(1, now - prevPointerTime);
    const speedPxPerMs = Math.hypot(dx, dy) / dtMs;
    prevPointerCanvasX = cx;
    prevPointerCanvasY = cy;
    prevPointerTime = now;
    applyCursorPush(cx, cy, dx, dy, speedPxPerMs);
  }

  function handlePointerLeave() {
    pointerMoveInited = false;
  }

  function setupGui() {
    gui = new GUI({ title: 'Магнитные кресты' });

    const fForm = gui.addFolder('Форма');
    fForm.add(params, 'crossScale', 0.3, 2.0, 0.01);
    fForm.add(params, 'spawnRadius', 0.5, 3.0, 0.05);
    fForm.add(params, 'attractorScreenPx', 10, 200, 1).name('зона притяж. (px)');

    const fCam = gui.addFolder('Камера');
    fCam.add(params, 'adaptiveFov').name('adaptive fov').onChange(applyAdaptiveFov);
    fCam.add(params, 'fovWideAspect', 1.5, 4.0, 0.05).name('aspect широкий').onChange(applyAdaptiveFov);
    fCam.add(params, 'fovNarrowAspect', 0.3, 1.5, 0.01).name('aspect узкий').onChange(applyAdaptiveFov);
    fCam.add(params, 'fovWide', 10, 60, 0.5).name('fov на широком').onChange(applyAdaptiveFov);
    fCam.add(params, 'fovNarrow', 10, 90, 0.5).name('fov на узком').onChange(applyAdaptiveFov);

    const fIntro = gui.addFolder('Intro');
    fIntro.add(params, 'introEnabled').name('включить');
    fIntro.add(params, 'introDuration', 0.1, 2.0, 0.05).name('длительность (s)');
    fIntro.add(params, 'introStaggerPerIndex', 0, 0.3, 0.005).name('stagger / index');
    fIntro.add(params, 'introBaseDelay', 0, 1.0, 0.01).name('базовая задержка');
    fIntro.add(params, 'introRotationDeg', 0, 360, 1).name('поворот (°)');
    fIntro
      .add(
        {
          replay: () => {
            introTime = 0;
          },
        },
        'replay'
      )
      .name('переиграть');

    const fMove = gui.addFolder('Движение');
    fMove.add(params, 'centerPullStrength', 0, 20, 0.1).name('притяжение к центру');
    fMove.add(params, 'linearDamping', 0.8, 0.99, 0.005).name('демпфинг скорости');
    fMove.add(params, 'collisionRadius', 0.5, 2.0, 0.01).name('радиус столкн.');
    fMove.add(params, 'collisionStiffness', 0, 30, 0.1).name('жёсткость столкн.');
    fMove.add(params, 'maxSpeed', 1, 40, 0.1).name('макс. скорость');
    fMove.add(params, 'angularDamping', 0.7, 0.99, 0.005).name('демпфинг вращ.');
    fMove.add(params, 'maxAngularSpeed', 0.5, 20, 0.1).name('макс. угл. скор.');
    fMove.add(params, 'collisionAngularKick', 0, 2, 0.01).name('угловой кик');
    fMove.add(params, 'ambientSpinStrength', 0, 0.1, 0.001).name('фоновая дрожь');
    fMove.add(params, 'spinFactorVariance', 0, 0.95, 0.01).name('разброс вертлявости').onChange(reseedSpinFactors);

    const fColor = gui.addFolder('Цвет');
    fColor.addColor(params, 'colorWhite').onChange(applyMaterialParams);
    fColor.addColor(params, 'colorBlue').onChange(applyMaterialParams);
    fColor.addColor(params, 'colorBlack').onChange(applyMaterialParams);
    fColor.addColor(params, 'sceneBg').onChange((v) => renderer.value.setClearColor(v));

    const fLight = gui.addFolder('Свет / материал');
    fLight
      .add(params, 'hemiIntensity', 0, 2, 0.01)
      .name('hemi (основной)')
      .onChange((v) => {
        hemiLight.intensity = v;
      });
    fLight
      .addColor(params, 'hemiSkyColor')
      .name('hemi sky')
      .onChange((v) => hemiLight.color.set(v));
    fLight
      .addColor(params, 'hemiGroundColor')
      .name('hemi ground')
      .onChange((v) => hemiLight.groundColor.set(v));
    fLight
      .add(params, 'dirLightIntensity', 0, 5, 0.01)
      .name('directional intensity')
      .onChange((v) => {
        dirLight.intensity = v;
      });
    fLight
      .addColor(params, 'dirLightColor')
      .name('directional color')
      .onChange((v) => dirLight.color.set(v));
    fLight
      .add(params, 'dirLightX', -30, 30, 0.5)
      .name('dir position X')
      .onChange((v) => dirLight.position.setX(v));
    fLight
      .add(params, 'dirLightY', -30, 30, 0.5)
      .name('dir position Y')
      .onChange((v) => dirLight.position.setY(v));
    fLight
      .add(params, 'dirLightZ', -30, 30, 0.5)
      .name('dir position Z')
      .onChange((v) => dirLight.position.setZ(v));
    fLight.add(params, 'matteRoughness', 0, 1, 0.01).name('matte roughness').onChange(applyMaterialParams);
    fLight.add(params, 'glossyRoughness', 0, 1, 0.01).name('glossy roughness').onChange(applyMaterialParams);

    const fCursor = gui.addFolder('Курсор');
    fCursor.add(params, 'screenHitPaddingPx', 0, 60, 1).name('допуск (px)');
    fCursor.add(params, 'pushStrength', 0, 100, 0.5).name('сила толчка');
    fCursor.add(params, 'pushSpeedRef', 0.2, 5, 0.05).name('реф. скорость (px/ms)');
    fCursor.add(params, 'pushSpeedExp', 0.5, 3, 0.05).name('экспонента кривой');
    fCursor.add(params, 'pushMinFactor', 0, 0.5, 0.01).name('мин. множитель');
    fCursor.add(params, 'pushMaxFactor', 0.5, 8, 0.05).name('макс. множитель');

    gui
      .add(
        {
          restart: () => window.dispatchEvent(new CustomEvent('effect-restart')),
        },
        'restart'
      )
      .name('перезапуск');

    // Все папки свёрнуты по умолчанию.
    gui.folders.forEach((f) => f.close());
  }

  onMounted(async () => {
    setupLights();

    try {
      sharedGeometry = await loadBufGeometry(crossModelUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[cross] model load failed', err);
      return;
    }

    createCrosses(sharedGeometry);
    setupGui();

    canvas.value.addEventListener('pointermove', handlePointerMove);
    canvas.value.addEventListener('pointerleave', handlePointerLeave);
    canvas.value.addEventListener('click', handleCanvasClick);

    applyAdaptiveFov();
    onResize(() => applyAdaptiveFov());

    onTick((dt) => {
      if (!crosses.length) return;
      const stepDt = Math.min(dt, 1 / 30);
      introTime += stepDt;
      physicsStep(stepDt);
      composeTransforms();
    });
  });

  onBeforeUnmount(() => {
    gui?.destroy();
    if (canvas.value) {
      canvas.value.removeEventListener('pointermove', handlePointerMove);
      canvas.value.removeEventListener('pointerleave', handlePointerLeave);
      canvas.value.removeEventListener('click', handleCanvasClick);
    }
    crosses.forEach(({ mesh }) => mesh.material.dispose());
    crosses = [];
    sharedGeometry?.dispose();
  });
</script>

<style lang="scss" scoped>
  .cross-stage {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 90vw;
    height: 700px;
    border-radius: 40px;
    overflow: hidden;
    background: #0a0b10;

    &__canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  }
</style>
