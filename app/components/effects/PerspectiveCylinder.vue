<!--
  Цилиндр из точек, лежащий вдоль оси Z (уходит «в даль»).
  Камера смещена сбоку и чуть снизу — видна боковина и низ.
  Без брифа: быстрый прототип, чтобы согласовать композицию и пропорции.
-->
<template>
  <canvas ref="canvas" class="perspective-cylinder" />
</template>

<script setup>
  import * as THREE from 'three';
  import GUI from 'lil-gui';

  const canvas = ref(null);

  // FOV пониже → перспектива «спокойнее», но всё равно заметна разница ближнего/дальнего конца.
  // Камера: x — увод вбок, y — чуть ниже центра цилиндра, z — отступ от ближнего торца.
  const { scene, camera, mouse, onTick, size, renderer } = useScene(canvas, {
    fov: 45,
    near: 0.1,
    far: 100,
    cameraPosition: [1.2, -0.5, 5.5],
    clearColor: 0x0e0e12,
  });

  // Параметры формы — здесь же, чтобы потом легко вынести в GUI.
  const RADIUS = 0.5;
  const LENGTH = 7;
  // Сетка анизотропна: радиально плотно (кольца читаются как сплошные линии),
  // вдоль оси — редко (между кольцами явный промежуток, они не сливаются друг с другом).
  // шаг по окружности ≈ 2π·R / RADIAL ≈ 3.14·1 / 64 ≈ 0.049 (~2.5× от size=0.02)
  // шаг вдоль оси    ≈ LENGTH / LENGTH_SEGS ≈ 7 / 26 ≈ 0.27 (~13× от size=0.02)
  const RADIAL_SEGMENTS = 64;
  const LENGTH_SEGMENTS = 26;

  let points = null;
  let circleTexture = null;
  let gui = null;
  let basePositions = null; // эталонная сетка точек до деформации
  let pointerInside = false;

  // Intro: смешанная сборка. Большинство точек — индивидуальный хаотичный scatter.
  // 2-3 случайных кольца получают «дугу» (1/4..1/2 кольца) — единственный читаемый структурный элемент.
  // Параллельно opacity 0→1 и камера-зум (см. INTRO_CAM_START_Z).
  const INTRO_DURATION = 2.3;
  const INTRO_CAM_START_Z = 1.0;
  const INTRO_PARTIAL_RINGS = 3; // сколько колец будут «дугами», остальные точки — хаос
  const INTRO_ARC_MIN = 0.25; // мин. доля кольца в дуге (1/4)
  const INTRO_ARC_MAX = 0.5; // макс. доля кольца в дуге (1/2)
  const INTRO_RING_OFFSET_X = 4.5;
  const INTRO_RING_OFFSET_Y = 3.5;
  const INTRO_RING_OFFSET_Z = 2.0;
  const INTRO_RING_TILT = Math.PI * 0.6;
  const INTRO_RING_TWIST = Math.PI * 0.9;
  const INTRO_SPIN_RATE = 4.0;
  // Хаотичный scatter — для всех точек, не входящих в дуги.
  const INTRO_SCATTER_X = 4.0;
  const INTRO_SCATTER_Y = 3.0;
  const INTRO_SCATTER_Z = 1.5;
  let ringOffsets = null;
  let ringEulers = null;
  let ringSpinRates = null;
  let ringMatrices = null;
  let isStructural = null; // Uint8Array: 1 = в дуге, 0 = в хаосе
  let pointScatter = null; // Float32Array(numPoints*3) — для хаотичных точек
  let introElapsed = 0;
  let introDone = false;

  // Reusables для intro-цикла, без аллокаций per-frame.
  const tmpIntroEuler = new THREE.Euler();
  const tmpIntroVec = new THREE.Vector3();
  // Цель lookAt держим отдельным объектом — three не хранит её, а перевычисляет в rotation.
  // Без этого слайдеры камеры теряли бы привязку при изменении позиции.
  const lookAtTarget = { x: 0, y: 0, z: 0 };

  // «Пользовательские» база позиции/вращения объекта. На каждом кадре поверх неё накладываем wobble.
  // Если биндить GUI напрямую на points.position, ветер каждый кадр перетирал бы значение и слайдеры дёргались бы.
  const userBasePos = { x: 0.5, y: -0.2, z: 0 };
  const userBaseRot = { x: 0, y: 0, z: 0 };

  // База позиции камеры — GUI биндится сюда, а не на camera.position напрямую,
  // потому что scroll-логика каждый кадр перезаписывает camera.position лерпом базы → внутри трубы.
  const baseCamPos = { x: 1.2, y: -0.5, z: 5.5 };

  // Scroll-эффект: scroll 0..1 синхронно выравнивает трубу и залетает камерой в центр.
  // На progress=1: points.position=(0,0,0), points.rotation=(0,0,0), camera=(0,0,0) (в центре трубы),
  // lookAt=(0,0,-5) — смотрим вдоль -Z.
  // Радиальный «трубопровод»: чем дальше точка от центра трубы по Z, тем сильнее xy-радиус
  // растягивается с ростом scroll. На входе/выходе — раструб, в середине — узко.
  const SCROLL_DISTANCE_PX = 1500;
  const SCROLL_LERP_RATE = 4;
  const SCROLL_CAM_TARGET = { x: 0, y: 0, z: 0 };
  const SCROLL_LOOK_TARGET = { x: 0, y: 0, z: -5 };
  const SCROLL_CURSOR_DISABLE = 0.05;
  const SCROLL_RADIUS_CENTER = 0.9; // прибавка к радиусу в центре трубы при sp=1 (×1 → ×1.9)
  const SCROLL_RADIUS_END = 3.5; // прибавка к радиусу на торцах при sp=1 (×1 → ×4.5)
  const SCROLL_LENGTH_GROWTH = 3.0; // длина трубы при sp=1: ×(1 + это) = ×4
  let scrollAccum = 0;
  let scrollProgress = 0;

  // «Ветровые» колебания: сумма синусов с несоизмеримыми частотами даёт неперепокривающийся «органик».
  // amplitude — общий мастер-скейл, speed — масштаб времени. Дефолты подобраны под «почти незаметно».
  const wobble = {
    amplitude: 0.5,
    speed: 3,
  };

  // Анти-магнит: радиус — в пикселях экрана (расстояние от курсора до проекции точки),
  // strength — макс. смещение в world-units, lerpRate — фрейм-независимая скорость возврата.
  // depthAttenuation — ослабление силы для дальних точек: 0 = равномерно по всей длине,
  //                    1 = дальний торец вообще не двигается. Накладывается на естественное
  //                    перспективное уменьшение, которое уже есть само по себе.
  const cursor = {
    pushRadiusPx: 200,
    pushStrength: 0.25,
    lerpRate: 14,
    depthAttenuation: 0.7,
  };

  // Reusables — переиспользуем между кадрами, чтобы не аллоцировать в горячем цикле.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const inverseMatrix = new THREE.Matrix4();
  const tmpWorld = new THREE.Vector3(); // мировые коорд. точки
  const tmpNdc = new THREE.Vector3(); // NDC-проекция точки
  const tmpTarget = new THREE.Vector3(); // целевая позиция в мире, потом → local

  // Круглый спрайт для точек: дешевле, чем кастомный ShaderMaterial, и не тянет внешний ассет.
  // PointsMaterial по дефолту рисует квадрат — текстура с alphaTest обрезает углы.
  function makeCircleTexture(size = 64) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const r = size / 2;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    return new THREE.CanvasTexture(canvas);
  }

  // Гейтим эффект на pointermove/pointerleave — иначе при выходе курсора из канваса
  // mouse.x/y из useScene остаются на последнем значении, и точки бы «зависли» деформированными.
  const handlePointerMove = () => {
    pointerInside = true;
  };
  const handlePointerLeave = () => {
    pointerInside = false;
  };

  // Wheel — драйвер scroll-эффекта. preventDefault, чтобы страница не прокручивалась под канвасом.
  // Верхней границы нет — scrollAccum растёт неограниченно, в фазе-2 progress > 1 крутит flowOffset.
  const handleWheel = (e) => {
    scrollAccum = Math.max(0, scrollAccum + e.deltaY);
    e.preventDefault();
  };

  // Цвета лерпятся по scroll: на sp=0 фон тёмный + точки светлые, на sp=1 — инверсия.
  // FADE_TARGET всегда совпадает с текущим bgColor — точки сливаются с фоном на дальнем торце.
  const POINT_COLOR_START = new THREE.Color(0x6c6c6c); // светло-серый
  const POINT_COLOR_END = new THREE.Color(0x202020); // тёмный после инверсии
  const BG_COLOR_START = new THREE.Color(0x0e0e12);
  const BG_COLOR_END = new THREE.Color(0xffffff);
  const tmpColorBg = new THREE.Color();
  const tmpColorPt = new THREE.Color();
  const tmpColorVertex = new THREE.Color();

  // Сетка точек по боковой поверхности цилиндра. Без замыкания (j от 0 до RADIAL-1) —
  // точка j=RADIAL совпадает с j=0 и даёт визуальный «двойной» пиксель на шве.
  // Параллельно с position генерим color: ближний торец = POINT_COLOR, дальний = фон.
  function buildCylinderPointsGeometry(radius, length, radialSegs, lengthSegs) {
    const positions = [];
    const colors = [];
    const halfLen = length / 2;
    const tmpColor = new THREE.Color();

    for (let i = 0; i <= lengthSegs; i++) {
      const z = -halfLen + (length * i) / lengthSegs;
      // nearness ∈ [0..1]: 0 = дальний торец, 1 = ближний.
      const nearness = (z + halfLen) / length;
      // smoothstep по длине — мягкая полка у дальнего тиипа: цвет = фон с производной 0,
      // граница «трубы» не читается резкой, торец визуально размыт в темноту.
      const t = nearness * nearness * (3 - 2 * nearness);
      tmpColor.copy(BG_COLOR_START).lerp(POINT_COLOR_START, t);

      for (let j = 0; j < radialSegs; j++) {
        const a = (j / radialSegs) * Math.PI * 2;
        positions.push(Math.cos(a) * radius, Math.sin(a) * radius, z);
        colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  }

  onMounted(() => {
    const geometry = buildCylinderPointsGeometry(RADIUS, LENGTH, RADIAL_SEGMENTS, LENGTH_SEGMENTS);
    // Эталон храним отдельно: каждый кадр считаем target от basePositions, current → target лерпом.
    // Без отдельного эталона деформация копится и точки «уплывают».
    basePositions = new Float32Array(geometry.attributes.position.array);

    // Per-ring transform для тех колец, что станут дугами. Для остальных колец данные не используются,
    // но дешевле сгенерить на все, чем держать sparse-структуру.
    const numRings = LENGTH_SEGMENTS + 1;
    const numPoints = numRings * RADIAL_SEGMENTS;
    ringOffsets = new Float32Array(numRings * 3);
    ringEulers = new Float32Array(numRings * 3);
    ringSpinRates = new Float32Array(numRings * 3);
    ringMatrices = new Array(numRings);
    isStructural = new Uint8Array(numPoints);
    pointScatter = new Float32Array(numPoints * 3);

    for (let r = 0; r < numRings; r++) {
      const mag = 0.4 + Math.random() * 0.6;
      ringOffsets[r * 3] = (Math.random() * 2 - 1) * INTRO_RING_OFFSET_X * mag;
      ringOffsets[r * 3 + 1] = (Math.random() * 2 - 1) * INTRO_RING_OFFSET_Y * mag;
      ringOffsets[r * 3 + 2] = (Math.random() * 2 - 1) * INTRO_RING_OFFSET_Z * mag;
      ringEulers[r * 3] = (Math.random() * 2 - 1) * INTRO_RING_TILT * mag;
      ringEulers[r * 3 + 1] = (Math.random() * 2 - 1) * INTRO_RING_TILT * mag;
      ringEulers[r * 3 + 2] = (Math.random() * 2 - 1) * INTRO_RING_TWIST * mag;
      ringSpinRates[r * 3] = (Math.random() * 2 - 1) * INTRO_SPIN_RATE * mag;
      ringSpinRates[r * 3 + 1] = (Math.random() * 2 - 1) * INTRO_SPIN_RATE * mag;
      ringSpinRates[r * 3 + 2] = (Math.random() * 2 - 1) * INTRO_SPIN_RATE * mag;
      ringMatrices[r] = new THREE.Matrix4();
    }

    // Выбираем INTRO_PARTIAL_RINGS случайных индексов колец, у которых будет читаемая дуга.
    const partialRings = new Set();
    while (partialRings.size < INTRO_PARTIAL_RINGS && partialRings.size < numRings) {
      partialRings.add(Math.floor(Math.random() * numRings));
    }

    for (let r = 0; r < numRings; r++) {
      const isPartial = partialRings.has(r);
      let arcStart = 0;
      let arcLen = 0;
      if (isPartial) {
        arcStart = Math.floor(Math.random() * RADIAL_SEGMENTS);
        arcLen = Math.floor(RADIAL_SEGMENTS * (INTRO_ARC_MIN + Math.random() * (INTRO_ARC_MAX - INTRO_ARC_MIN)));
      }
      for (let j = 0; j < RADIAL_SEGMENTS; j++) {
        const ptIdx = r * RADIAL_SEGMENTS + j;
        let inArc = false;
        if (isPartial) {
          const off = (j - arcStart + RADIAL_SEGMENTS) % RADIAL_SEGMENTS;
          inArc = off < arcLen;
        }
        isStructural[ptIdx] = inArc ? 1 : 0;
        if (!inArc) {
          // Хаотичный scatter с per-point magnitude 0.3..1.0.
          const m = 0.3 + Math.random() * 0.7;
          pointScatter[ptIdx * 3] = (Math.random() * 2 - 1) * INTRO_SCATTER_X * m;
          pointScatter[ptIdx * 3 + 1] = (Math.random() * 2 - 1) * INTRO_SCATTER_Y * m;
          pointScatter[ptIdx * 3 + 2] = (Math.random() * 2 - 1) * INTRO_SCATTER_Z * m;
        }
      }
    }

    // Стартовые позиции — записываем в буфер до первого render'а.
    const initArr = geometry.attributes.position.array;
    for (let r = 0; r < numRings; r++) {
      tmpIntroEuler.set(ringEulers[r * 3], ringEulers[r * 3 + 1], ringEulers[r * 3 + 2]);
      ringMatrices[r].makeRotationFromEuler(tmpIntroEuler);
    }
    for (let i = 0; i < initArr.length; i += 3) {
      const ptIdx = i / 3;
      if (isStructural[ptIdx]) {
        const ringIdx = Math.floor(ptIdx / RADIAL_SEGMENTS);
        const ringCz = basePositions[i + 2];
        tmpIntroVec.set(basePositions[i], basePositions[i + 1], 0).applyMatrix4(ringMatrices[ringIdx]);
        initArr[i] = ringOffsets[ringIdx * 3] + tmpIntroVec.x;
        initArr[i + 1] = ringOffsets[ringIdx * 3 + 1] + tmpIntroVec.y;
        initArr[i + 2] = ringCz + ringOffsets[ringIdx * 3 + 2] + tmpIntroVec.z;
      } else {
        initArr[i] = basePositions[i] + pointScatter[ptIdx * 3];
        initArr[i + 1] = basePositions[i + 1] + pointScatter[ptIdx * 3 + 1];
        initArr[i + 2] = basePositions[i + 2] + pointScatter[ptIdx * 3 + 2];
      }
    }
    // sizeAttenuation: true — дальние точки уменьшаются по перспективе вместе с поверхностью.
    // size — в мировых единицах. 0.04 при радиусе 0.5 даёт уверенный зазор между точками.
    circleTexture = makeCircleTexture();
    const material = new THREE.PointsMaterial({
      // vertexColors: true — material.color мультипликативно (white = «чистый» vertex color).
      // Цвет и затухание заданы per-vertex в геометрии.
      color: 0xffffff,
      vertexColors: true,
      size: 0.02,
      sizeAttenuation: true,
      map: circleTexture,
      // alphaTest снижен с 0.5 до 0.1, чтобы intro fade-in (opacity 0..1) не отрезал точки на низких opacity.
      // Корнеры текстуры (alpha=0) всё равно отсекаются.
      alphaTest: 0.1,
      transparent: true,
      // Стартуем невидимыми — intro поднимет opacity до 1 за INTRO_DURATION.
      opacity: 0,
    });
    points = new THREE.Points(geometry, material);
    // Сдвиг по X/Y компенсирует асимметрию композиции от камеры в (+x, -y):
    // ближний торец крупный, дальний мелкий — без сдвига цилиндр визуально «улетает» в верх-лево.
    // Реальное значение задаётся в onTick как userBasePos + wobble.
    points.position.set(userBasePos.x, userBasePos.y, userBasePos.z);
    points.rotation.set(userBaseRot.x, userBaseRot.y, userBaseRot.z);
    scene.value.add(points);

    canvas.value.addEventListener('pointermove', handlePointerMove);
    canvas.value.addEventListener('pointerleave', handlePointerLeave);
    // Wheel — на window, чтобы ловить скролл независимо от фокуса. passive:false — нужно для preventDefault.
    window.addEventListener('wheel', handleWheel, { passive: false });

    // Анти-магнит. Алгоритм:
    //  1. Луч курсора (raycaster) — в world-space.
    //  2. Для каждой точки: переводим в world, проецируем в NDC → пиксели, считаем 2D-расстояние до курсора.
    //  3. Если < pushRadiusPx — push'им точку перпендикулярно лучу наружу
    //     (point - closestOnRay). Это симметричное движение для ближней и дальней стенки:
    //     обе расходятся от линии курсора в противоположные стороны.
    //  4. Сила скейлится depth-фактором (ближний торец сильнее, дальний слабее).
    //  5. target_world → target_local через inverse(matrixWorld), лерп current → target.
    onTick((dt, elapsed) => {
      if (!points || !basePositions) return;

      // Intro state: считаем заранее, чтобы использовать и для камеры (zoom-out), и для сборки точек ниже.
      if (!introDone) introElapsed += dt;
      const introProgress = introDone ? 1 : Math.min(1, introElapsed / INTRO_DURATION);
      const introEased = 1 - Math.pow(1 - introProgress, 3);

      // Scroll: сглаживаем target → current. ali — фаза выравнивания трубы и камеры.
      const scrollTarget = scrollAccum / SCROLL_DISTANCE_PX;
      scrollProgress += (scrollTarget - scrollProgress) * (1 - Math.exp(-SCROLL_LERP_RATE * dt));
      const ali = Math.min(1, scrollProgress);

      // Камера-зум во время intro: z стартует на INTRO_CAM_START_Z=1, отдаляется до baseCamPos.z=5.5
      // синхронно со сборкой точек (общий introEased — ease-out cubic).
      const introCamZ = INTRO_CAM_START_Z + (baseCamPos.z - INTRO_CAM_START_Z) * introEased;

      // Wobble: 2-3 синуса с несоизмеримыми частотами на ось. Без сдвига фаз и одинаковых частот
      // движение читается как одна правильная синусоида и выдаёт искусственность.
      const tw = elapsed * wobble.speed;
      const a = wobble.amplitude;
      const wx = a * (Math.sin(tw * 0.41) * 0.012 + Math.sin(tw * 0.97 + 1.7) * 0.006);
      const wy = a * (Math.sin(tw * 0.37 + 1.2) * 0.014 + Math.sin(tw * 1.13 + 0.4) * 0.007);
      const wz = a * Math.sin(tw * 0.29 + 2.1) * 0.008;
      const wrx = a * Math.sin(tw * 0.31) * 0.006;
      const wry = a * Math.sin(tw * 0.51 + 0.7) * 0.004;
      const wrz = a * Math.sin(tw * 0.43 + 1.3) * 0.007;

      // Выравнивание трубы по scroll: userBasePos/Rot * (1-ali) + wobble.
      // На progress=0 — userBasePos + wobble (текущий вид). На progress=1 — (0,0,0) + wobble (на оси).
      const oneMinusAli = 1 - ali;
      points.position.set(userBasePos.x * oneMinusAli + wx, userBasePos.y * oneMinusAli + wy, userBasePos.z * oneMinusAli + wz);
      points.rotation.set(userBaseRot.x * oneMinusAli + wrx, userBaseRot.y * oneMinusAli + wry, userBaseRot.z * oneMinusAli + wrz);

      // Камера: lerp effective-базы (с intro-зумом по Z) → SCROLL_CAM_TARGET. lookAt → (0,0,0).
      camera.value.position.set(
        baseCamPos.x + (SCROLL_CAM_TARGET.x - baseCamPos.x) * ali,
        baseCamPos.y + (SCROLL_CAM_TARGET.y - baseCamPos.y) * ali,
        introCamZ + (SCROLL_CAM_TARGET.z - introCamZ) * ali
      );
      camera.value.lookAt(
        lookAtTarget.x + (SCROLL_LOOK_TARGET.x - lookAtTarget.x) * ali,
        lookAtTarget.y + (SCROLL_LOOK_TARGET.y - lookAtTarget.y) * ali,
        lookAtTarget.z + (SCROLL_LOOK_TARGET.z - lookAtTarget.z) * ali
      );

      // Цветовая инверсия по scroll: фон тёмный → белый, точки светлые → тёмные.
      // Старт инверсии задержан до ali=0.7 — пока почти не влетели внутрь, цвета остаются
      // оригинальными. smoothstep плавно ускоряется и доезжает до полной инверсии к ali=1.
      // FADE_TARGET для каждой точки = текущий bgColor, чтобы дальний торец сливался с фоном.
      // ~1700 точек × 3 float = копейки на upload в GPU каждый кадр.
      const colorPhase = Math.max(0, Math.min(1, (ali - 0.25) / 0.3));
      const colorBlend = colorPhase * colorPhase * (3 - 2 * colorPhase);
      tmpColorBg.copy(BG_COLOR_START).lerp(BG_COLOR_END, colorBlend);
      tmpColorPt.copy(POINT_COLOR_START).lerp(POINT_COLOR_END, colorBlend);
      renderer.value.setClearColor(tmpColorBg);
      const colorAttr = points.geometry.attributes.color;
      const colorArr = colorAttr.array;
      const halfLenColor = LENGTH / 2;
      for (let pi = 0; pi < basePositions.length; pi += 3) {
        const z = basePositions[pi + 2];
        const nearness = (z + halfLenColor) / LENGTH;
        const tFade = nearness * nearness * (3 - 2 * nearness);
        tmpColorVertex.copy(tmpColorBg).lerp(tmpColorPt, tFade);
        colorArr[pi] = tmpColorVertex.r;
        colorArr[pi + 1] = tmpColorVertex.g;
        colorArr[pi + 2] = tmpColorVertex.b;
      }
      colorAttr.needsUpdate = true;

      const arr = points.geometry.attributes.position.array;

      // Intro-анимация: дуги колец лерпят transform к identity (плюс затухающий спин), хаотичные точки
      // лерпят индивидуальный scatter к нулю. Курсорный эффект и финальный bend выключены.
      if (!introDone) {
        const blend = 1 - introEased;
        const numRingsTick = ringMatrices.length;
        for (let r = 0; r < numRingsTick; r++) {
          const ex = (ringEulers[r * 3] + ringSpinRates[r * 3] * introElapsed) * blend;
          const ey = (ringEulers[r * 3 + 1] + ringSpinRates[r * 3 + 1] * introElapsed) * blend;
          const ez = (ringEulers[r * 3 + 2] + ringSpinRates[r * 3 + 2] * introElapsed) * blend;
          tmpIntroEuler.set(ex, ey, ez);
          ringMatrices[r].makeRotationFromEuler(tmpIntroEuler);
        }
        for (let i = 0; i < arr.length; i += 3) {
          const ptIdx = i / 3;
          if (isStructural[ptIdx]) {
            const ringIdx = Math.floor(ptIdx / RADIAL_SEGMENTS);
            const ringCz = basePositions[i + 2];
            tmpIntroVec.set(basePositions[i], basePositions[i + 1], 0).applyMatrix4(ringMatrices[ringIdx]);
            arr[i] = ringOffsets[ringIdx * 3] * blend + tmpIntroVec.x;
            arr[i + 1] = ringOffsets[ringIdx * 3 + 1] * blend + tmpIntroVec.y;
            arr[i + 2] = ringCz + ringOffsets[ringIdx * 3 + 2] * blend + tmpIntroVec.z;
          } else {
            arr[i] = basePositions[i] + pointScatter[ptIdx * 3] * blend;
            arr[i + 1] = basePositions[i + 1] + pointScatter[ptIdx * 3 + 1] * blend;
            arr[i + 2] = basePositions[i + 2] + pointScatter[ptIdx * 3 + 2] * blend;
          }
        }
        points.material.opacity = introEased;
        points.geometry.attributes.position.needsUpdate = true;
        if (introProgress >= 1) {
          introDone = true;
          points.material.opacity = 1;
        }
        return;
      }

      const t = 1 - Math.exp(-cursor.lerpRate * dt);

      // Курсор в пикселях относительно центра канваса (тот же координатный фрейм, что NDC*half).
      const halfW = size.width / 2;
      const halfH = size.height / 2;
      // useScene хранит mouse.y с y-up в [0..1] — совпадает с осью NDC по знаку.
      const cursorPxX = (mouse.x - 0.5) * size.width;
      const cursorPxY = (mouse.y - 0.5) * size.height;

      let rayValid = false;
      // Курсорный анти-магнит выключаем при активном скролле — внутри трубы искажения не нужны.
      if (pointerInside && scrollProgress < SCROLL_CURSOR_DISABLE) {
        ndc.set(mouse.x * 2 - 1, mouse.y * 2 - 1);
        raycaster.setFromCamera(ndc, camera.value);
        rayValid = true;
      }

      points.updateMatrixWorld();
      inverseMatrix.copy(points.matrixWorld).invert();

      const Rpx = cursor.pushRadiusPx;
      const Rpx2 = Rpx * Rpx;
      const strength = cursor.pushStrength;
      const depthAtten = cursor.depthAttenuation;
      const ray = raycaster.ray;
      const halfLen = LENGTH / 2;
      // Радиальный масштаб по scroll: центр и края растут с разной силой → раструб.
      // normZ²: 0 в центре, 1 на торцах. Квадрат вместо линейного даёт более «трубопроводный» силует —
      // в центре труба остаётся узкой, расширяется только ближе к концам.
      const scaleCenter = 1 + ali * SCROLL_RADIUS_CENTER;
      const scaleEnd = 1 + ali * SCROLL_RADIUS_END;
      // Удлинение трубы по scroll: x2 в финале. Колор-градиент остаётся консистентным —
      // он завязан на basePositions, а не на displayed z, так что цветовая разметка не плывёт.
      const lengthScale = 1 + ali * SCROLL_LENGTH_GROWTH;

      for (let i = 0; i < arr.length; i += 3) {
        const baseZ = basePositions[i + 2];
        const normZ = baseZ / halfLen; // -1..1 — нормировка по ОРИГИНАЛЬНОЙ длине
        const normZ2 = normZ * normZ;
        const radialScale = scaleCenter + (scaleEnd - scaleCenter) * normZ2;
        const bx = basePositions[i] * radialScale;
        const by = basePositions[i + 1] * radialScale;
        const bz = baseZ * lengthScale;

        // Default target = эталон (если не в зоне или курсор вне канваса).
        let txL = bx;
        let tyL = by;
        let tzL = bz;

        if (rayValid) {
          // Local → world.
          tmpWorld.set(bx, by, bz).applyMatrix4(points.matrixWorld);

          // World → NDC → пиксели от центра.
          tmpNdc.copy(tmpWorld).project(camera.value);
          const screenPxX = tmpNdc.x * halfW;
          const screenPxY = tmpNdc.y * halfH;

          const dpx = screenPxX - cursorPxX;
          const dpy = screenPxY - cursorPxY;
          const dist2 = dpx * dpx + dpy * dpy;

          if (dist2 < Rpx2) {
            const dist = Math.sqrt(dist2);
            const u = dist / Rpx;
            // smoothstep-фолофф: 1 в эпицентре, 0 на границе. Без него край деформации виден ступенькой.
            const fall = 1 - u * u * (3 - 2 * u);

            // Depth attenuation. Локальная Z = «вдоль оси цилиндра»: bz=+halfLen — ближний к камере торец,
            // bz=-halfLen — дальний. nearness ∈ [0..1]: 0 = дальний, 1 = ближний.
            // depthFactor линейно: 1 на ближнем, (1 - depthAtten) на дальнем.
            // Дальние точки реально получают меньше push в мировых единицах, плюс перспектива даёт
            // дополнительное сжатие на экране — суммарно разлёт визуально гасится в даль.
            const nearness = (bz + halfLen) / LENGTH;
            const depthFactor = 1 - depthAtten * (1 - nearness);
            const totalScale = fall * depthFactor;

            // Перпендикуляр от луча к точке: P - origin минус проекция (P-origin) на dir.
            const ox = tmpWorld.x - ray.origin.x;
            const oy = tmpWorld.y - ray.origin.y;
            const oz = tmpWorld.z - ray.origin.z;
            const d = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
            const perpX = ox - d * ray.direction.x;
            const perpY = oy - d * ray.direction.y;
            const perpZ = oz - d * ray.direction.z;
            const plen = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);

            if (plen > 1e-8) {
              const mag = (strength * totalScale) / plen;
              // target_world = base_world + perp * mag
              tmpTarget.set(tmpWorld.x + perpX * mag, tmpWorld.y + perpY * mag, tmpWorld.z + perpZ * mag);
              // target_world → target_local
              tmpTarget.applyMatrix4(inverseMatrix);
              txL = tmpTarget.x;
              tyL = tmpTarget.y;
              tzL = tmpTarget.z;
            }
          }
        }

        arr[i] += (txL - arr[i]) * t;
        arr[i + 1] += (tyL - arr[i + 1]) * t;
        arr[i + 2] += (tzL - arr[i + 2]) * t;
      }

      points.geometry.attributes.position.needsUpdate = true;
    });

    // GUI для подгонки кадра. Все слайдеры биндятся напрямую на инстансы three —
    // слайдер дёргает .position.x объекта, three сам подхватит на следующем кадре.
    gui = new GUI({ title: 'Подгонка кадра' });

    // FOV меняется на инстансе камеры, но без updateProjectionMatrix three не перерисует фрустум.
    const applyFov = () => {
      camera.value.updateProjectionMatrix();
    };

    const camFolder = gui.addFolder('Камера');
    camFolder.add(camera.value, 'fov', 10, 110, 0.5).name('fov').onChange(applyFov);
    // Биндим на baseCamPos/lookAtTarget — они «база», от которой scroll лерпит к SCROLL_*_INSIDE.
    // Если биндить на camera.value.position, изменения слайдера затрутся scroll-override'ом в onTick.
    camFolder.add(baseCamPos, 'x', -10, 10, 0.05).name('pos x');
    camFolder.add(baseCamPos, 'y', -10, 10, 0.05).name('pos y');
    camFolder.add(baseCamPos, 'z', -10, 20, 0.05).name('pos z');
    camFolder.add(lookAtTarget, 'x', -5, 5, 0.05).name('look x');
    camFolder.add(lookAtTarget, 'y', -5, 5, 0.05).name('look y');
    camFolder.add(lookAtTarget, 'z', -5, 5, 0.05).name('look z');

    const cursorFolder = gui.addFolder('Курсор (анти-магнит)');
    cursorFolder.add(cursor, 'pushRadiusPx', 10, 300, 1).name('радиус (px)');
    cursorFolder.add(cursor, 'pushStrength', 0, 1, 0.01).name('сила');
    cursorFolder.add(cursor, 'lerpRate', 1, 40, 0.5).name('скорость возврата');
    cursorFolder.add(cursor, 'depthAttenuation', 0, 1, 0.01).name('затухание вдаль');

    const objFolder = gui.addFolder('Объект');
    // Биндим на userBase*, а не на points.position/rotation — чтобы wobble не перетирал значения слайдеров.
    objFolder.add(userBasePos, 'x', -3, 3, 0.01).name('pos x');
    objFolder.add(userBasePos, 'y', -3, 3, 0.01).name('pos y');
    objFolder.add(userBasePos, 'z', -3, 3, 0.01).name('pos z');
    objFolder.add(userBaseRot, 'x', -Math.PI, Math.PI, 0.01).name('rot x');
    objFolder.add(userBaseRot, 'y', -Math.PI, Math.PI, 0.01).name('rot y');
    objFolder.add(userBaseRot, 'z', -Math.PI, Math.PI, 0.01).name('rot z');

    const wobbleFolder = gui.addFolder('Колебания (ветер)');
    wobbleFolder.add(wobble, 'amplitude', 0, 5, 0.05).name('амплитуда');
    wobbleFolder.add(wobble, 'speed', 0, 3, 0.05).name('скорость');

    // Кнопка перезапускает эффект через перемонтирование компонента — слушает страница [slug].vue.
    const actions = {
      restart: () => window.dispatchEvent(new CustomEvent('effect-restart')),
    };
    gui.add(actions, 'restart').name('перезапуск');

    // Все папки свёрнуты по умолчанию — при открытии эффекта GUI не загромождает экран.
    gui.folders.forEach((f) => f.close());
  });

  onBeforeUnmount(() => {
    gui?.destroy();
    if (canvas.value) {
      canvas.value.removeEventListener('pointermove', handlePointerMove);
      canvas.value.removeEventListener('pointerleave', handlePointerLeave);
    }
    window.removeEventListener('wheel', handleWheel);
    if (!points) return;
    points.geometry.dispose();
    points.material.dispose();
    circleTexture?.dispose();
  });
</script>

<style lang="scss" scoped>
  .perspective-cylinder {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
