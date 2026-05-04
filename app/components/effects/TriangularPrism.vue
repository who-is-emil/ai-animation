<!--
  Полая треугольная призма из анодированного алюминия.

  Геометрия — ExtrudeGeometry из Shape (внешний равносторонний треугольник со скруглёнными
  углами через absarc) + Path (внутренний треугольник как hole). Шейп строится в локальной
  XY-плоскости, экструдируется по +Z, потом меш поворачивается на -π/2 по X — призма встаёт
  вертикально вдоль мирового +Y.

  Свет: AmbientLight + два DirectionalLight симметрично слева-сверху и справа-сверху от
  камеры (azimuth ≈ ±100° от фронт-вектора, elevation ≈ 35°). Это даёт нужный градиент:
  фронтальная грань (нормаль +Z) почти не освещена direct-светом и держится на ambient,
  две боковые грани повёрнуты к источникам — заметно ярче.

  Из-за того, что MeshStandardMaterial без envMap на металлах выглядит «пластмассово», по
  умолчанию подключён RoomEnvironment через PMREM. Можно выключить чекбоксом — тогда металл
  держится только на direct + ambient.
-->
<template>
  <canvas ref="canvas" class="triangular-prism" />
</template>

<script setup>
  import * as THREE from 'three';
  import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
  import GUI from 'lil-gui';

  const canvas = ref(null);

  const { scene, camera, renderer, onTick, onResize } = useScene(canvas, {
    fov: 35,
    near: 0.1,
    far: 100,
    cameraPosition: [0, 0, 1],
    clearColor: 0x1a1a1d,
  });

  // Все художественные параметры в одном месте — удобно для GUI и Log params.
  const params = {
    // Форма
    outerRadius: 1.0,
    innerRadius: 0.8,
    height: 11,
    edgeRadius: 0.1,
    innerEdgeRadius: 0.1,
    bevelSize: 0,
    curveSegments: 64,

    // Эффекты — переключаются по клику. Каждый эффект задаёт цвет призмы и наличие
    // фоновых частиц. Транзишн между эффектами плавный (TRANSITION_DURATION).
    effects: [
      { color: '#C7CBCF', particles: false },
      { color: '#D9B65B', particles: true },
    ],

    // Параметры фонового облака частиц (только для эффектов с particles: true).
    // Распределение со смещением вправо (densitySkew < 1), движение справа налево.
    particles: {
      count: 30000,
      color: '#D9B65B',
      // Радиальное распределение от точки-источника. Расстояние от источника распределено
      // экспоненциально (-scale * ln(1-r)) → плотность максимальна на источнике и резко
      // спадает с удалением. Угол — конус с раствором spreadAngle, центр π (влево).
      sourceX: 16,
      sourceY: 8,
      spreadAngle: 180,
      scale: 10,
      ySquash: 1,
      speed: 0.5,
      sizeMin: 1.5,
      sizeMax: 6, // верхняя граница для крупных «капель краски» (12% от общего количества)
      softness: 14, // крутизна gaussian fall-off: 8 — мягкий туман, 20 — почти точечная пыльца
      minLife: 3,
      maxLife: 10,
      fadeIn: 0.6,
      fadeOut: 1.5,
      zMin: -10,
      zMax: 0,
      zJitter: 0.01,
    },

    // Материал
    metalness: 1.0, // чистый металл — без этого PBR-материал ощущается «пластиковым»
    roughness: 0.35,
    // Тип env-карты: 'off' — без отражений (металл будет тёмным),
    // 'soft' — мягкий градиент-env «небо→земля» без бликов (рекомендуемый по умолчанию),
    // 'room' — RoomEnvironment, даёт характерные блики от «окон в потолке».
    envMode: 'soft',
    envMapIntensity: 1.5, // сила отражений окружения. Управляет «металлом» сильнее, чем metalness
    exposure: 1.2, // toneMappingExposure для ACESFilmic — общая яркость кадра

    // Фон — радиальный виньет-градиент: центр темнее, края светлее. Зерно поверх.
    // Оба цвета по умолчанию совпадают (#676B71) — фон выглядит однотонным;
    // подкручивай в GUI, чтобы получить виньет-эффект.
    bgColorCenter: '#15171A',
    bgColorEdge: '#8A8F95',
    bgFalloff: 0.7, // степень спада от центра: 0.5 — мягкий, 1 — линейный, 2 — резкий
    grainStrength: 0.03,

    // Свет (значения для физически-корректных источников — three.js r155+).
    // Каждый источник управляется независимо: enabled/intensity/azimuth/elevation/color.
    // Дефолтные позиции: 1+2 — пара верхне-боковых (ключ+заполняющий), 3 — сверху, 4 — сзади.
    lights: [
      { enabled: true, intensity: 0.7, azimuth: 102, elevation: -27, color: '#ffffff' },
      { enabled: true, intensity: 1.5, azimuth: -99, elevation: -5, color: '#ffffff' },
      { enabled: true, intensity: 6.8, azimuth: 156, elevation: 17, color: '#ffffff' },
      { enabled: true, intensity: 1.15, azimuth: -1, elevation: 22, color: '#ffffff' },
    ],
    ambientIntensity: 0.5,

    // Кадр
    objectYaw: 60, // призма повёрнута ребром (углом) к камере
    fov: 45,
    cameraDist: 6.7,
    cameraAngle: 25,
    targetYRatio: 0.88, // доля от height — точка прицеливания (1.0 = ровно верхушка)
  };

  let mesh = null;
  let group = null;
  let geometry = null;
  let material = null;
  let bgMesh = null;
  let bgGeometry = null;
  let bgMaterial = null;
  let particlesMesh = null;
  let particlesGeometry = null;
  let particlesMaterial = null;
  let particlesState = null; // { positions, velocities, lifes, maxLifes, opacities, sizes, brightnesses }
  const directionalLights = []; // массив THREE.DirectionalLight по индексу из params.lights
  let ambientLight = null;
  let pmremGenerator = null;
  let softEnvMap = null;
  let roomEnvMap = null;
  let gui = null;
  let onCanvasClick = null;

  // Состояние переключения эффектов.
  // currentEffectIndex — куда «летим» (целевой эффект).
  // prevEffectIndex — откуда летим (для интерполяции).
  // transitionT в [0..1]: при 1 трансформация завершена.
  const TRANSITION_DURATION = 0.7;
  let currentEffectIndex = 0;
  let prevEffectIndex = 0;
  let transitionT = 1;
  const _fromColor = new THREE.Color();
  const _toColor = new THREE.Color();

  // Построение профиля скруглённого равностороннего треугольника.
  // R — радиус описанной окружности (центр→вершина).
  // r — радиус скругления углов.
  // Возвращает Shape или Path (для hole) в зависимости от targetCtor.
  function buildRoundedTriangle(R, r, targetCtor) {
    const path = new targetCtor();
    // Вершины равностороннего треугольника — на углах 90°, 210°, 330° от центра.
    // Верхняя вершина смотрит вверх (+Y) в локальном XY — после поворота меша на -π/2 по X
    // эта вершина уезжает в -Z (за объект от камеры), а нижняя сторона (между V1 и V2)
    // становится фронтальной гранью с нормалью +Z. Так получаем «грань фронтально к камере».
    const baseAngles = [Math.PI / 2, (7 * Math.PI) / 6, (11 * Math.PI) / 6];

    // Углы внешних нормалей сторон (i-1, i) — биссектрисы между соседними вершинами.
    const sideNormals = baseAngles.map((_, i) => {
      const prev = baseAngles[(i + 2) % 3];
      let cur = baseAngles[i];
      if (cur < prev) cur += 2 * Math.PI;
      return (prev + cur) / 2;
    });

    // Центры дуг скругления: на биссектрисе вершины, на расстоянии 2r от неё внутрь
    // (для угла 60° равностороннего треугольника). От центра треугольника это (R - 2r).
    // Радиальные коэффициенты совпадают с косинусом/синусом угла вершины.
    const cornerCenters = baseAngles.map((a) => [(R - 2 * r) * Math.cos(a), (R - 2 * r) * Math.sin(a)]);

    for (let i = 0; i < 3; i++) {
      const [cx, cy] = cornerCenters[i];
      const startAngle = sideNormals[i];
      let endAngle = sideNormals[(i + 1) % 3];
      if (endAngle < startAngle) endAngle += 2 * Math.PI;

      const startX = cx + r * Math.cos(startAngle);
      const startY = cy + r * Math.sin(startAngle);

      if (i === 0) {
        path.moveTo(startX, startY);
      } else {
        // Прямой сегмент стороны треугольника между точкой выхода предыдущей дуги и
        // точкой входа текущей. absarc сам не добавляет lineTo, поэтому делаем явно.
        path.lineTo(startX, startY);
      }
      path.absarc(cx, cy, r, startAngle, endAngle, false);
    }
    return path;
  }

  function buildGeometry() {
    // Ограничения: edgeRadius < min(R) / 2 (иначе треугольник вырождается).
    // Бьём по факту, не запрещаем заранее — слайдеры в GUI ограничены.
    const outerShape = buildRoundedTriangle(params.outerRadius, params.edgeRadius, THREE.Shape);
    const innerPath = buildRoundedTriangle(params.innerRadius, params.innerEdgeRadius, THREE.Path);
    outerShape.holes.push(innerPath);

    const geo = new THREE.ExtrudeGeometry(outerShape, {
      depth: params.height,
      bevelEnabled: params.bevelSize > 0.0001,
      bevelThickness: params.bevelSize,
      bevelSize: params.bevelSize,
      bevelOffset: 0,
      bevelSegments: 3,
      curveSegments: params.curveSegments,
    });
    // ExtrudeGeometry экструдирует по +Z от Z=0 до Z=depth. Сдвигаем по Z, чтобы основание
    // призмы оказалось в локальном Z=0. После поворота меша Z уезжает в +Y → основание встанет
    // на мировой пол (Y=0), верх — в Y=height.
    // Без сдвига нет (Z уже идёт 0..depth), но bevelEnabled добавляет немного «вылета» за
    // 0..depth с обеих сторон — компенсировать не будем, разница незаметная.
    geo.computeVertexNormals();
    return geo;
  }

  function rebuildGeometry() {
    if (!mesh) return;
    const newGeo = buildGeometry();
    mesh.geometry.dispose();
    mesh.geometry = newGeo;
    geometry = newGeo;
  }

  // Применить настройки одного источника (позиция, цвет, интенсивность с учётом enabled).
  // Позиция — сферические координаты вокруг origin: azimuth от +Z по часовой (взгляд сверху),
  // elevation от горизонтального плана; +90° — точно сверху.
  function applyLightConfig(i) {
    const cfg = params.lights[i];
    const light = directionalLights[i];
    if (!light) return;
    const az = (cfg.azimuth * Math.PI) / 180;
    const el = (cfg.elevation * Math.PI) / 180;
    const dist = 20;
    light.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist);
    light.color.set(cfg.color);
    light.intensity = cfg.enabled ? cfg.intensity : 0;
  }

  // Камера и точка наведения вычисляются из параметров. Камера статична — никаких контролов.
  function applyCameraFromParams() {
    const targetY = params.height * params.targetYRatio;
    const angle = (params.cameraAngle * Math.PI) / 180;
    const d = params.cameraDist;
    camera.value.position.set(0, targetY + Math.sin(angle) * d, Math.cos(angle) * d);
    camera.value.lookAt(0, targetY, 0);
    camera.value.fov = params.fov;
    camera.value.updateProjectionMatrix();
  }

  // Синтетический «мягкий» env — равномерный градиент яркости по широте сферы окружения.
  // Не имеет точечных источников, поэтому не даёт характерных «оконных» бликов на скруглениях
  // рёбер; зато даёт ровную светимость металла, без которой metalness=1 выглядит чёрным.
  function buildSoftEnvMap() {
    const w = 32;
    const h = 16;
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1); // 0 — верх сферы (небо), 1 — низ (земля)
      const v = 2.0 * (1.0 - t) + 0.18 * t; // линейный градиент яркости (HDR — пик 2.0)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i + 0] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 1;
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    const env = pmremGenerator.fromEquirectangular(tex).texture;
    tex.dispose();
    return env;
  }

  function applyEnvMap() {
    if (!scene.value || !pmremGenerator) return;
    if (params.envMode === 'off') {
      scene.value.environment = null;
    } else if (params.envMode === 'soft') {
      if (!softEnvMap) softEnvMap = buildSoftEnvMap();
      scene.value.environment = softEnvMap;
    } else if (params.envMode === 'room') {
      if (!roomEnvMap) {
        const envScene = new RoomEnvironment();
        roomEnvMap = pmremGenerator.fromScene(envScene, 0.04).texture;
      }
      scene.value.environment = roomEnvMap;
    }
  }

  // Фоновый full-screen quad: рисуется первым (renderOrder=-1, без depth-теста).
  // Vertex-shader пишет gl_Position напрямую в clip-space — плоскость 2x2 в NDC покрывает весь экран
  // вне зависимости от камеры. Fragment-shader смешивает два цвета по vUv.y и добавляет hash-зерно
  // от gl_FragCoord, чтобы фон не выглядел плоским градиентом.
  const BG_VERTEX_SHADER = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 1.0, 1.0);
    }
  `;
  const BG_FRAGMENT_SHADER = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform vec3 uColorCenter;
    uniform vec3 uColorEdge;
    uniform float uFalloff;
    uniform vec2 uAspect;       // (width / max, height / max) — нормализация дистанции под форму экрана
    uniform float uGrainStrength;

    // Хеш-функция (Hugo Elias-style) — на каждом пикселе детерминированное псевдослучайное число.
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      // Радиальная дистанция от центра, скорректированная под аспект (иначе на широком
      // экране градиент стал бы вертикально-сплюснутым эллипсом).
      vec2 p = (vUv - 0.5) * 2.0 * uAspect; // в [-aspect, +aspect]
      float d = clamp(length(p), 0.0, 1.0);
      float t = pow(d, max(uFalloff, 0.05));
      vec3 col = mix(uColorCenter, uColorEdge, t);
      float n = hash(gl_FragCoord.xy) - 0.5;
      col += n * uGrainStrength;
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // Шейдеры облака «пыльцы». Per-particle атрибуты:
  //  aOpacity    — opacity жизненного цикла (fade-in/out).
  //  aSize       — размер в CSS px (умножается на pixelRatio в шейдере).
  //  aBrightness — индивидуальный множитель плотности (0.4..1.0) — даёт разнообразие частицам,
  //                чтобы не выглядели одним штампом.
  // Форма всегда одна — gaussian soft-puff. Это ключ к ощущению аэрозоля: жёсткие края
  // (квадраты, кресты) превращают облако в «штампы», мягкий gaussian — в туман.
  const PARTICLE_VERTEX_SHADER = /* glsl */ `
    attribute float aOpacity;
    attribute float aSize;
    attribute float aBrightness;
    varying float vOpacity;
    varying float vBrightness;
    uniform float uPixelRatio;
    uniform float uGlobalOpacity;
    void main() {
      vOpacity = aOpacity * uGlobalOpacity;
      vBrightness = aBrightness;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uPixelRatio;
      gl_Position = projectionMatrix * mvPosition;
    }
  `;
  const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
    precision highp float;
    varying float vOpacity;
    varying float vBrightness;
    uniform vec3 uColor;
    uniform float uSoftness;  // крутизна gaussian: больше — резче точка, меньше — мягче туман
    void main() {
      if (vOpacity < 0.001) discard;
      vec2 c = gl_PointCoord - vec2(0.5);
      float d2 = dot(c, c);
      // Gaussian falloff: alpha = exp(-d^2 * k). При k=16, d=0.5 → exp(-4) ≈ 0.018 (на краю почти 0).
      float a = exp(-d2 * uSoftness);
      if (a < 0.02) discard;
      gl_FragColor = vec4(uColor, vOpacity * a * vBrightness);
    }
  `;

  function spawnParticle(i, randomLife) {
    const p = params.particles;
    const s = particlesState;
    // Угол: центр конуса = π (влево от источника), разброс ±spreadAngle/2.
    const spreadRad = (p.spreadAngle * Math.PI) / 180;
    const angle = Math.PI + (Math.random() - 0.5) * spreadRad;
    // Радиус: экспоненциальное распределение — плотность максимальна на источнике,
    // быстро падает с расстоянием. clamp на 0.99, чтобы log не уехал в -∞.
    const r = -p.scale * Math.log(1 - Math.random() * 0.99);
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r * p.ySquash;
    s.positions[i * 3] = p.sourceX + dx;
    s.positions[i * 3 + 1] = p.sourceY + dy;
    s.positions[i * 3 + 2] = p.zMin + Math.random() * (p.zMax - p.zMin);
    // Скорость направлена от источника наружу (по углу), с jitter ±30%.
    const speedFactor = 0.7 + Math.random() * 0.6;
    s.velocities[i * 3] = Math.cos(angle) * p.speed * speedFactor;
    s.velocities[i * 3 + 1] = Math.sin(angle) * p.speed * speedFactor * p.ySquash;
    s.velocities[i * 3 + 2] = (Math.random() - 0.5) * p.zJitter;
    s.maxLifes[i] = p.minLife + Math.random() * (p.maxLife - p.minLife);
    s.lifes[i] = randomLife ? Math.random() * s.maxLifes[i] : 0;
    s.opacities[i] = 0;
    // Размер: 12% частиц — крупные «капли краски» в верхней части диапазона sizeMax,
    // остальные — мелкая пыльца. Это даёт характерную для аэрозоля смесь «туман + редкие капли».
    if (Math.random() < 0.12) {
      s.sizes[i] = p.sizeMax * (0.85 + Math.random() * 0.4);
    } else {
      s.sizes[i] = p.sizeMin + Math.random() * (p.sizeMax - p.sizeMin) * 0.7;
    }
    s.brightnesses[i] = 0.4 + Math.random() * 0.6;
  }

  function rebuildParticles() {
    if (particlesMesh) {
      scene.value.remove(particlesMesh);
      particlesGeometry.dispose();
      particlesMaterial.dispose();
      particlesMesh = null;
    }
    buildParticles();
    scene.value.add(particlesMesh);
  }

  function buildParticles() {
    const PCOUNT = params.particles.count;
    particlesState = {
      positions: new Float32Array(PCOUNT * 3),
      velocities: new Float32Array(PCOUNT * 3),
      lifes: new Float32Array(PCOUNT),
      maxLifes: new Float32Array(PCOUNT),
      opacities: new Float32Array(PCOUNT),
      sizes: new Float32Array(PCOUNT),
      brightnesses: new Float32Array(PCOUNT),
    };
    for (let i = 0; i < PCOUNT; i++) spawnParticle(i, true);

    particlesGeometry = new THREE.BufferGeometry();
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlesState.positions, 3));
    particlesGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(particlesState.opacities, 1));
    particlesGeometry.setAttribute('aSize', new THREE.BufferAttribute(particlesState.sizes, 1));
    particlesGeometry.setAttribute('aBrightness', new THREE.BufferAttribute(particlesState.brightnesses, 1));

    particlesMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      uniforms: {
        uPixelRatio: { value: renderer.value.getPixelRatio() },
        uGlobalOpacity: { value: params.effects[currentEffectIndex].particles ? 1 : 0 },
        uColor: { value: new THREE.Color(params.particles.color) },
        uSoftness: { value: params.particles.softness },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    particlesMesh.frustumCulled = false;
  }

  function updateParticles(dt) {
    const p = params.particles;
    const s = particlesState;
    const PCOUNT = s.lifes.length;
    for (let i = 0; i < PCOUNT; i++) {
      s.lifes[i] += dt;
      if (s.lifes[i] >= s.maxLifes[i]) {
        spawnParticle(i, false);
        continue;
      }
      s.positions[i * 3] += s.velocities[i * 3] * dt;
      s.positions[i * 3 + 1] += s.velocities[i * 3 + 1] * dt;
      s.positions[i * 3 + 2] += s.velocities[i * 3 + 2] * dt;
      const life = s.lifes[i];
      const ml = s.maxLifes[i];
      let o = 1;
      if (life < p.fadeIn) o = life / p.fadeIn;
      if (ml - life < p.fadeOut) o = Math.min(o, (ml - life) / p.fadeOut);
      s.opacities[i] = o < 0 ? 0 : o > 1 ? 1 : o;
    }
    particlesGeometry.attributes.position.needsUpdate = true;
    particlesGeometry.attributes.aOpacity.needsUpdate = true;
    particlesGeometry.attributes.aSize.needsUpdate = true;
    particlesGeometry.attributes.aBrightness.needsUpdate = true;
  }

  // Переключение эффекта по клику. Запоминаем from/to и запускаем transition.
  function switchEffect() {
    prevEffectIndex = currentEffectIndex;
    currentEffectIndex = (currentEffectIndex + 1) % params.effects.length;
    transitionT = 0;
  }

  // Smoothstep — мягкая ease-in-out кривая для transitionT.
  function easeInOut(t) {
    return t * t * (3 - 2 * t);
  }

  onMounted(() => {
    geometry = buildGeometry();
    material = new THREE.MeshStandardMaterial({
      color: params.effects[0].color,
      metalness: params.metalness,
      roughness: params.roughness,
      envMapIntensity: params.envMapIntensity,
      flatShading: false,
    });

    mesh = new THREE.Mesh(geometry, material);
    // Поворот меша на -π/2 по X: экструзия по +Z уезжает в мировой +Y → призма стоит вертикально.
    // Локальная вершина V0 (вверху профиля) уезжает в -Z (за объект от камеры),
    // нижняя сторона профиля V1-V2 даёт фронтальную грань с нормалью +Z.
    mesh.rotation.x = -Math.PI / 2;

    // Yaw применяется на родительской Group, а НЕ на mesh.rotation.y. Иначе по дефолтному
    // rotation order 'XYZ' Y-вращение пошло бы вокруг локальной Y меша, которая после
    // наклона по X смотрит на камеру → объект завалился бы набок. На уровне Group
    // вращение идёт вокруг мировой Y до наклона — это и есть «крутить вокруг вертикальной оси».
    group = new THREE.Group();
    group.add(mesh);
    group.rotation.y = (params.objectYaw * Math.PI) / 180;
    scene.value.add(group);

    // Фоновый quad. PlaneGeometry(2,2) попадает в clip-space через прямой gl_Position
    // в шейдере — не зависит от камеры. depthTest:false + renderOrder:-1 — рендерится
    // первым и не пишется в depth-буфер, так что не мешает призме.
    bgGeometry = new THREE.PlaneGeometry(2, 2);
    bgMaterial = new THREE.ShaderMaterial({
      vertexShader: BG_VERTEX_SHADER,
      fragmentShader: BG_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uColorCenter: { value: new THREE.Color(params.bgColorCenter) },
        uColorEdge: { value: new THREE.Color(params.bgColorEdge) },
        uFalloff: { value: params.bgFalloff },
        uAspect: { value: new THREE.Vector2(1, 1) },
        uGrainStrength: { value: params.grainStrength },
      },
    });
    bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    bgMesh.frustumCulled = false;
    bgMesh.renderOrder = -1;
    scene.value.add(bgMesh);

    // Частицы создаются один раз. Видимость управляется uGlobalOpacity (0 на эффекте без частиц).
    // Размещены в Z<-3 — за призмой; depthTest по призме автоматически их перекроет в зоне силуэта.
    buildParticles();
    scene.value.add(particlesMesh);

    // Аспект для радиального градиента: чтобы окружность не плющилась на широких экранах,
    // нормализуем дистанцию по бóльшей стороне (равной 1). На квадрате uAspect=(1,1).
    const updateBgAspect = (w, h) => {
      const m = Math.max(w, h);
      bgMaterial.uniforms.uAspect.value.set(w / m, h / m);
    };
    const r0 = canvas.value.getBoundingClientRect();
    updateBgAspect(r0.width || 1, r0.height || 1);
    onResize(({ width, height }) => updateBgAspect(width, height));

    ambientLight = new THREE.AmbientLight(0xffffff, params.ambientIntensity);
    scene.value.add(ambientLight);

    params.lights.forEach((_, i) => {
      const light = new THREE.DirectionalLight(0xffffff, 0);
      scene.value.add(light);
      directionalLights.push(light);
      applyLightConfig(i);
    });

    pmremGenerator = new THREE.PMREMGenerator(renderer.value);
    pmremGenerator.compileEquirectangularShader();
    applyEnvMap();

    // ACESFilmic + exposure — без toneMapping HDR-значения env обрезаются и металл выглядит тёмным,
    // а яркие участки уходят в плоский белый. ACES даёт мягкий S-curve roll-off.
    renderer.value.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.value.toneMappingExposure = params.exposure;

    applyCameraFromParams();

    // Click на canvas → следующий эффект. Браузер не emit'ит click если pointer был в drag,
    // так что c OrbitControls не конфликтует (поворот камеры мышью — это drag, не click).
    onCanvasClick = () => switchEffect();
    canvas.value.addEventListener('click', onCanvasClick);

    onTick((dt) => {
      // Transition: лерпим цвет призмы и opacity частиц.
      if (transitionT < 1) {
        transitionT = Math.min(1, transitionT + dt / TRANSITION_DURATION);
        const t = easeInOut(transitionT);
        _fromColor.set(params.effects[prevEffectIndex].color);
        _toColor.set(params.effects[currentEffectIndex].color);
        material.color.copy(_fromColor).lerp(_toColor, t);
        const fromP = params.effects[prevEffectIndex].particles ? 1 : 0;
        const toP = params.effects[currentEffectIndex].particles ? 1 : 0;
        particlesMaterial.uniforms.uGlobalOpacity.value = fromP + (toP - fromP) * t;
      }
      updateParticles(dt);
    });

    // Минимальный GUI: только переключение эффектов и цвета. Все «технические» параметры
    // (форма, материал, свет, камера, фон, частицы) убраны — крутятся через дефолты в коде.
    gui = new GUI({ title: 'Треугольная призма' });
    gui.add({ next: switchEffect }, 'next').name('следующий эффект (клик)');
    params.effects.forEach((eff, i) => {
      gui
        .addColor(eff, 'color')
        .name(`цвет эффекта ${i + 1}`)
        .onChange((v) => {
          // Если это активный эффект и transition не идёт — сразу применяем материалу.
          if (i === currentEffectIndex && transitionT >= 1) material.color.set(v);
        });
    });
  });

  onBeforeUnmount(() => {
    if (canvas.value && onCanvasClick) {
      canvas.value.removeEventListener('click', onCanvasClick);
    }
    gui?.destroy();
    geometry?.dispose();
    material?.dispose();
    bgGeometry?.dispose();
    bgMaterial?.dispose();
    particlesGeometry?.dispose();
    particlesMaterial?.dispose();
    softEnvMap?.dispose();
    roomEnvMap?.dispose();
    pmremGenerator?.dispose();
  });
</script>

<style lang="scss" scoped>
  .triangular-prism {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
