<!--
  Вихрь сфер.
  Облако маленьких сфер, закручённых вокруг светящейся точки. GPGPU-симуляция:
  каждая частица — 4 флоата (xyz + life), хранятся в RGBA32F-FBO размера 128×128.
  Силы: спин вокруг центра (половина потока в одну сторону, половина в обратную)
  + 4D simplex curl-noise. Жизнь убывает, при <0 респаун из default-распределения
  (равномерно в сферическом слое R∈[0.25; 0.75]).
  Бриф: briefs/about-hero-vortex.md
-->
<template>
  <canvas ref="canvas" class="about-hero-vortex" />
</template>

<script setup>
  import * as THREE from 'three';
  import GUI from 'lil-gui';

  const canvas = ref(null);

  const { scene, renderer, onTick } = useScene(canvas, {
    fov: 60,
    near: 0.1,
    far: 200,
    cameraPosition: [0, 0, 8],
    clearColor: 0x07080c,
  });

  // Параметры симуляции и рендера. Всё, что меняется через GUI, — здесь.
  const params = reactive({
    introRatio: 1,
    autoIntro: false,
    noiseSpeed: 1.25,
    spinStrength: 1,
    curlStrength: 1.5,
    lifeDecaySpeed: 1,
    sizeEmissive: 0.166,
    sizeNonEmissive: 0.097,
    lightX: 0,
    lightY: 0,
    lightZ: 0,
    sphereSegments: 8,
    bgColor: '#000000',
    baseColor: '#b0b0b0',
    emissiveColor: '#ffffff',
    scatterEnabled: true,
    scatterRatio: 0.85,
    bloom: 0,
    paused: false,
  });

  // ---------- helpers ----------
  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const saturate = (v) => clamp(v, 0, 1);
  const mix = (a, b, t) => a + (b - a) * t;
  const smoothstep01 = (e0, e1, x) => {
    const t = saturate((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  const fit = (v, fMin, fMax, tMin, tMax, ease) => {
    const t = saturate((v - fMin) / (fMax - fMin));
    return tMin + (tMax - tMin) * (ease ? ease(t) : t);
  };
  // Порт класса из исходника. 1D-шум на массиве из 512 случайных значений ∈ [-0.5, 0.5],
  // smoothstep между соседями. getFbm — сумма N октав с persistence 0.5.
  class Simple1DNoise {
    static MAX_VERTICES = 512;
    static MASK = 511;
    constructor() {
      this._scale = 1;
      this._amplitude = 1;
      this._r = new Float32Array(Simple1DNoise.MAX_VERTICES);
      for (let i = 0; i < Simple1DNoise.MAX_VERTICES; i++) this._r[i] = Math.random() - 0.5;
    }
    getVal(x) {
      const t = x * this._scale;
      const r = Math.floor(t);
      const n = t - r;
      const a = n * n * (3 - 2 * n);
      const i0 = r & Simple1DNoise.MASK;
      const i1 = (i0 + 1) & Simple1DNoise.MASK;
      return mix(this._r[i0], this._r[i1], a) * this._amplitude;
    }
    getFbm(x, oct) {
      let r = 0;
      let amp = 0.5;
      let f = x;
      for (let i = 0; i < oct; i++) {
        r += amp * this.getVal(f);
        f *= 2;
        amp *= 0.5;
      }
      return r;
    }
  }

  // ---------- GLSL ----------

  // Чанк blue-noise (sampler с per-frame офсетом).
  const GLSL_BLUE_NOISE = `
    uniform sampler2D u_blueNoiseTexture;
    uniform vec2 u_blueNoiseTexelSize;
    uniform vec2 u_blueNoiseCoordOffset;
    vec3 getBlueNoise(vec2 coord) {
      return texture2D(u_blueNoiseTexture, coord * u_blueNoiseTexelSize + u_blueNoiseCoordOffset).rgb;
    }
  `;

  // Чанк volumetric scatter (рассеяние по линии — вертикальная "свеча" от лампы вниз).
  const GLSL_SCATTER = `
    uniform vec2 u_lightScatterDivider;
    uniform float u_lightScatterPowInv;
    uniform vec3 u_lightScatterPos0;
    uniform vec3 u_lightScatterPos1;
    uniform float u_lightScatterRatio;
    float getScatterCoff(vec3 start, vec3 dir, vec3 lightPos, float d) {
      vec3 q = start - lightPos;
      float b = dot(dir, q);
      float c = dot(q, q);
      float t = c - b * b;
      float s = 1.0 / (2.5 + pow(0.001 + t, 0.8));
      return s * (atan((d + b) * s) - atan(b * s));
    }
    vec2 getScatterLine(vec3 start, vec3 dir, vec3 a, vec3 b, float d) {
      vec3 segCenter = (a + b) * 0.5;
      vec3 segDir = normalize(b - a);
      vec3 diff = start - segCenter;
      float segExtent = distance(a, b) * 0.5;
      float a01 = -dot(dir, segDir);
      float b0 = dot(diff, dir);
      float b1 = -dot(diff, segDir);
      float det = abs(1.0 - a01 * a01);
      float s = clamp((a01 * b0 - b1) / max(0.0001, det), -segExtent, segExtent);
      vec3 lp = segDir * s + segCenter;
      return vec2(getScatterCoff(start, dir, segExtent > 0.0 ? lp : a, d), s / segExtent * 0.5 + 0.5);
    }
    float getScatter(vec3 cam, vec3 worldPos) {
      vec3 wc = worldPos - cam;
      float d = length(wc);
      vec3 dir = wc / d;
      vec2 val = getScatterLine(cam, dir, u_lightScatterPos0, u_lightScatterPos1, d);
      return pow(max(0.0, val.x / mix(u_lightScatterDivider.x, u_lightScatterDivider.y, val.y)), u_lightScatterPowInv) * u_lightScatterRatio;
    }
  `;

  // 4D simplex-noise + curl. Один-в-один из исходного fragSim — это самая ценная часть,
  // именно она обеспечивает "витание" частиц.
  const GLSL_CURL_NOISE = `
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    float mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    float permute(float x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float taylorInvSqrt(float r) { return 1.79284291400159 - 0.85373472095314 * r; }
    vec4 grad4(float j, vec4 ip) {
      const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
      vec4 p, s;
      p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
      p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
      s = vec4(lessThan(p, vec4(0.0)));
      p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
      return p;
    }
    #define F4 0.309016994374947451
    vec4 simplexNoiseDerivatives(vec4 v) {
      const vec4 C = vec4(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);
      vec4 i = floor(v + dot(v, vec4(F4)));
      vec4 x0 = v - i + dot(i, C.xxxx);
      vec4 i0;
      vec3 isX = step(x0.yzw, x0.xxx);
      vec3 isYZ = step(x0.zww, x0.yyz);
      i0.x = isX.x + isX.y + isX.z;
      i0.yzw = 1.0 - isX;
      i0.y += isYZ.x + isYZ.y;
      i0.zw += 1.0 - isYZ.xy;
      i0.z += isYZ.z;
      i0.w += 1.0 - isYZ.z;
      vec4 i3 = clamp(i0, 0.0, 1.0);
      vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
      vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);
      vec4 x1 = x0 - i1 + C.xxxx;
      vec4 x2 = x0 - i2 + C.yyyy;
      vec4 x3 = x0 - i3 + C.zzzz;
      vec4 x4 = x0 + C.wwww;
      i = mod289(i);
      float j0 = permute(permute(permute(permute(i.w) + i.z) + i.y) + i.x);
      vec4 j1 = permute(permute(permute(permute(i.w + vec4(i1.w, i2.w, i3.w, 1.0)) + i.z + vec4(i1.z, i2.z, i3.z, 1.0)) + i.y + vec4(i1.y, i2.y, i3.y, 1.0)) + i.x + vec4(i1.x, i2.x, i3.x, 1.0));
      vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
      vec4 p0 = grad4(j0, ip);
      vec4 p1 = grad4(j1.x, ip);
      vec4 p2 = grad4(j1.y, ip);
      vec4 p3 = grad4(j1.z, ip);
      vec4 p4 = grad4(j1.w, ip);
      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;
      p4 *= taylorInvSqrt(dot(p4, p4));
      vec3 values0 = vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2));
      vec2 values1 = vec2(dot(p3, x3), dot(p4, x4));
      vec3 m0 = max(0.5 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
      vec2 m1 = max(0.5 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);
      vec3 temp0 = -6.0 * m0 * m0 * values0;
      vec2 temp1 = -6.0 * m1 * m1 * values1;
      vec3 mmm0 = m0 * m0 * m0;
      vec2 mmm1 = m1 * m1 * m1;
      float dx = temp0[0]*x0.x + temp0[1]*x1.x + temp0[2]*x2.x + temp1[0]*x3.x + temp1[1]*x4.x + mmm0[0]*p0.x + mmm0[1]*p1.x + mmm0[2]*p2.x + mmm1[0]*p3.x + mmm1[1]*p4.x;
      float dy = temp0[0]*x0.y + temp0[1]*x1.y + temp0[2]*x2.y + temp1[0]*x3.y + temp1[1]*x4.y + mmm0[0]*p0.y + mmm0[1]*p1.y + mmm0[2]*p2.y + mmm1[0]*p3.y + mmm1[1]*p4.y;
      float dz = temp0[0]*x0.z + temp0[1]*x1.z + temp0[2]*x2.z + temp1[0]*x3.z + temp1[1]*x4.z + mmm0[0]*p0.z + mmm0[1]*p1.z + mmm0[2]*p2.z + mmm1[0]*p3.z + mmm1[1]*p4.z;
      float dw = temp0[0]*x0.w + temp0[1]*x1.w + temp0[2]*x2.w + temp1[0]*x3.w + temp1[1]*x4.w + mmm0[0]*p0.w + mmm0[1]*p1.w + mmm0[2]*p2.w + mmm1[0]*p3.w + mmm1[1]*p4.w;
      return vec4(dx, dy, dz, dw) * 49.0;
    }
    vec3 curl(vec3 p, float t, float persistence) {
      vec4 xd = vec4(0.0);
      vec4 yd = vec4(0.0);
      vec4 zd = vec4(0.0);
      for (int i = 0; i < 2; i++) {
        float twoPowI = pow(2.0, float(i));
        float scale = 0.5 * twoPowI * pow(persistence, float(i));
        xd += simplexNoiseDerivatives(vec4(p * twoPowI, t)) * scale;
        yd += simplexNoiseDerivatives(vec4((p + vec3(123.4, 129845.6, -1239.1)) * twoPowI, t)) * scale;
        zd += simplexNoiseDerivatives(vec4((p + vec3(-9519.0, 9051.0, -123.0)) * twoPowI, t)) * scale;
      }
      return vec3(xd[3] - zd[1], zd[2] - yd[3], yd[1] - xd[2]);
    }
  `;

  // Симуляция позиций — порт fragSim из исходника.
  const FS_SIMULATION = `
    precision highp float;
    uniform sampler2D u_simPrevPosLifeTexture;
    uniform sampler2D u_simDefaultPosLifeTexture;
    uniform float u_introDeltaTime;
    uniform float u_noiseTime;
    uniform float u_noiseScale;
    uniform float u_noiseStableFactor;
    uniform float u_spinStrength;
    uniform float u_curlStrength;
    uniform float u_lifeDecaySpeed;
    uniform vec3 u_lightPosition;
    varying vec2 v_uv;
    ${GLSL_CURL_NOISE}
    void main() {
      vec4 posLife = texture2D(u_simPrevPosLifeTexture, v_uv);
      posLife.w -= (0.5 + u_noiseStableFactor) * u_introDeltaTime * u_lifeDecaySpeed;

      // Респаун из default-распределения с пульсацией радиуса.
      if (posLife.w < 0.0) {
        vec3 defPosOrigin = texture2D(u_simDefaultPosLifeTexture, v_uv).xyz;
        vec3 defPos = defPosOrigin * (1.25 + sin(u_noiseTime * 2.5 + v_uv.x * 21.) * 0.25) + u_lightPosition;
        posLife.w += 1.0;
        posLife.xyz = defPos;
      }

      // Спин вокруг центра. Половина потока (по uv.y) — в одну сторону, половина — в обратную.
      vec3 toLight = posLife.xyz - u_lightPosition;
      vec3 axis = vec3(sin(u_noiseTime), cos(u_noiseTime * 2. + v_uv.y * 6.283185), 0.0);
      vec3 spinDir = cross(axis, toLight);
      float dist = length(toLight);
      if (dist > 0.01) {
        float spinStrength = u_introDeltaTime
          * (0.1 + smoothstep(0.5, 2.0, dist - v_uv.x * 0.5)
                 * (v_uv.y < 0.5 ? 1. : -1.)
                 * mix(2., 4., v_uv.x))
          * mix(0.75, 1.5, u_noiseStableFactor)
          * u_spinStrength;
        posLife.xyz += spinDir * spinStrength;
      }

      // Curl-noise.
      posLife.xyz += (1.25 + 0.5 * u_noiseScale)
        * curl((posLife.xyz - u_lightPosition) * (0.4 + 0.3 * u_noiseStableFactor), u_noiseTime, 0.2)
        * u_introDeltaTime
        * mix(0.4, 1.5, posLife.w * posLife.w)
        * mix(0.75, 1.25, v_uv.x)
        * u_curlStrength;

      gl_FragColor = posLife;
    }
  `;

  // Шейдер частиц — упрощённая версия frag$d. Вместо lightField используется точечный
  // свет в u_lightPosition + расстоянное затухание. Спекуляр считается через reflect.
  // Цвет берётся как mix(baseColor, emissiveColor, isEmissive).
  const VS_PARTICLES = `
    attribute vec2 simUv;
    uniform sampler2D u_simCurrPosLifeTexture;
    uniform float u_isEmissive;
    uniform float u_sceneHideRatio;
    uniform float u_sizeEmissive;
    uniform float u_sizeNonEmissive;
    uniform vec3 u_lightPosition;
    varying vec3 v_worldPosition;
    varying vec3 v_worldNormal;
    varying vec3 v_viewNormal;
    varying float v_diff;
    varying float v_emission;
    varying float v_depth;
    float linearStep(float a, float b, float x) { return clamp((x - a) / (b - a), 0.0, 1.0); }
    vec4 hash43(vec3 p) {
      vec4 p4 = fract(vec4(p.xyzx) * vec4(.1031, .1030, .0973, .1099));
      p4 += dot(p4, p4.wzxy + 33.33);
      return fract((p4.xxyz + p4.yzzw) * p4.zywx);
    }
    void main() {
      vec4 currPos = texture2D(u_simCurrPosLifeTexture, simUv);
      vec4 rands = hash43(vec3(simUv, 0.0));
      float baseSize = mix(u_sizeNonEmissive, u_sizeEmissive, u_isEmissive) * (0.5 + rands.x * 0.5);
      float lifeMask = linearStep(0.0, 0.1, currPos.w) * linearStep(1.0, 0.9, currPos.w);
      float pSize = baseSize * lifeMask * (1.0 - u_sceneHideRatio);

      vec3 pos = position * pSize + currPos.xyz;
      v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
      v_viewNormal = normalMatrix * normal;
      v_worldNormal = normalize((vec4(v_viewNormal, 0.0) * viewMatrix).xyz);

      // Точечный свет в позиции лампы — заменяет lightField.
      vec3 lightDir = normalize(u_lightPosition - v_worldPosition);
      float lightDist = max(0.001, distance(u_lightPosition, v_worldPosition));
      float atten = 1.0 / (0.05 + 0.04 * lightDist * lightDist);
      v_diff = (0.25 + 0.75 * max(0.0, dot(v_worldNormal, lightDir))) * atten;
      v_diff *= linearStep(5., 1.5, lightDist);

      v_emission = lifeMask * u_isEmissive;

      // aboutHeroVisualFinal_vert: линейная глубина.
      float viewZ = (modelViewMatrix * vec4(pos, 1.0)).z;
      float near = 1.;
      float far = 100.;
      v_depth = 1.0 - (viewZ + near) / (near - far);

      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;

  const FS_PARTICLES = `
    precision highp float;
    uniform vec3 u_lightPosition;
    uniform vec3 u_baseColor;
    uniform vec3 u_emissiveColor;
    uniform float u_isEmissive;
    varying vec3 v_worldPosition;
    varying vec3 v_worldNormal;
    varying vec3 v_viewNormal;
    varying float v_diff;
    varying float v_emission;
    varying float v_depth;
    ${GLSL_BLUE_NOISE}
    ${GLSL_SCATTER}
    float linearStep(float a, float b, float x) { return clamp((x - a) / (b - a), 0.0, 1.0); }
    void main() {
      vec3 noise = getBlueNoise(gl_FragCoord.xy);
      vec3 viewNormal = normalize(v_viewNormal);
      vec3 worldNormal = normalize(v_worldNormal);

      vec3 viewDir = normalize(cameraPosition - v_worldPosition);
      vec3 lightDir = normalize(u_lightPosition - v_worldPosition);
      vec3 reflDir = reflect(-viewDir, worldNormal);
      float spec = pow(max(0.0, dot(reflDir, lightDir)), 24.0) * 0.6;

      // Псевдо-fresnel — даёт яркую кромку у эмиссивных шариков.
      float fres = pow(1.0 - max(0.0, dot(worldNormal, viewDir)), 2.5);

      float shade = v_diff * 0.55 + spec + fres * 0.15;
      shade += getScatter(cameraPosition, v_worldPosition) * 1.35;

      // Эмиссивные через viewShade-замену (как в исходнике через v_emission * v_ao).
      float viewShade = linearStep(-1., 1., dot(viewNormal, vec3(0.5773)));
      shade = mix(shade, viewShade, v_emission);
      shade = mix(shade, smoothstep(0., 1., shade), 0.5);

      // Лёгкий blue-noise dithering — убирает банды на низких luma.
      shade += (noise.x - 0.5) * 0.015;

      vec3 color = mix(u_baseColor, u_emissiveColor, u_isEmissive);
      gl_FragColor = vec4(color * shade, 1.0);
    }
  `;

  // ---------- runtime ----------
  const SIM_W = 128;
  const SIM_H = 128;
  const PARTICLE_COUNT = SIM_W * SIM_H;

  // Состояние, инициализируется в onMounted.
  let simRTA = null;
  let simRTB = null;
  let simMaterial = null;
  let defaultPosTex = null;
  let blueNoiseTex = null;
  let quadScene = null;
  let quadCam = null;
  let quadMesh = null;
  let nonEmissiveMesh = null;
  let emissiveMesh = null;
  const baseColor3 = new THREE.Color();
  const emissiveColor3 = new THREE.Color();
  const bgColor3 = new THREE.Color();

  // Шумы для модуляции curl и stable factor — тоже из исходника.
  const noiseScaleNoise = new Simple1DNoise();
  const noiseStableNoise = new Simple1DNoise();
  let noiseTime = 0;
  let noiseScale = 0;
  let noiseScaleTime = Math.random() * 100;
  let noiseStableFactorTime = Math.random() * 100;
  let noiseStableFactorAcc = Math.random() * 100;
  let stableFactor = 0;

  let gui = null;

  // Создаёт DataTexture с равномерным распределением точек в сферическом слое
  // R∈[0.25; 0.75]. Хранится в локальных координатах (без offset на light).
  function createDefaultPosTexture() {
    const data = new Float32Array(PARTICLE_COUNT * 4);
    for (let i = 0, j = 0; i < PARTICLE_COUNT; i++, j += 4) {
      const u = Math.random() * 2 * Math.PI; // azimuth
      const f = Math.acos(2 * Math.random() - 1); // inclination
      const r = 0.25 + Math.cbrt(Math.random()) * 0.5; // [0.25, 0.75]
      data[j + 0] = r * Math.sin(f) * Math.cos(u);
      data[j + 1] = r * Math.sin(f) * Math.sin(u);
      data[j + 2] = r * Math.cos(f);
      data[j + 3] = i / PARTICLE_COUNT - 1; // life ∈ [-1, 0)
    }
    const tex = new THREE.DataTexture(data, SIM_W, SIM_H, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  // Процедурная blue-noise текстура. Не «настоящий» blue-noise (Воид-Кластер), но
  // распределённый по равномерной решётке шум — даёт нужный зернистый дизеринг
  // без бандинга. Для «правильного» blue-noise — заменить на загрузку .png.
  function createBlueNoiseTexture(sizePx = 128) {
    const data = new Uint8Array(sizePx * sizePx * 4);
    for (let i = 0; i < sizePx * sizePx; i++) {
      const o = i * 4;
      data[o + 0] = (Math.random() * 256) | 0;
      data[o + 1] = (Math.random() * 256) | 0;
      data[o + 2] = (Math.random() * 256) | 0;
      data[o + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, sizePx, sizePx, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  // Создаёт RGBA32F render target нужного размера, без depth-буфера.
  function createSimRT() {
    return new THREE.WebGLRenderTarget(SIM_W, SIM_H, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  // Рендерит fullscreen-quad с переданным материалом в указанный target.
  function renderToTarget(material, target) {
    quadMesh.material = material;
    const prev = renderer.value.getRenderTarget();
    renderer.value.setRenderTarget(target);
    renderer.value.render(quadScene, quadCam);
    renderer.value.setRenderTarget(prev);
  }

  // Инициализирует pre-state ping-pong: одну из текстур заполняем default-данными,
  // чтобы на первом тике sim шейдер прочитал валидную позицию из u_simPrevPosLifeTexture.
  function seedSimulation() {
    // three.js c glslVersion: GLSL3 сам префиксует "#version 300 es" — нам его писать нельзя.
    const seedMat = new THREE.RawShaderMaterial({
      uniforms: { u_src: { value: defaultPosTex } },
      vertexShader: 'in vec3 position;\nin vec2 uv;\nout vec2 v_uv;\nvoid main(){v_uv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader:
        'precision highp float;\nuniform sampler2D u_src;\nin vec2 v_uv;\nout vec4 fragColor;\nvoid main(){fragColor=texture(u_src,v_uv);}',
      glslVersion: THREE.GLSL3,
    });
    renderToTarget(seedMat, simRTA);
    renderToTarget(seedMat, simRTB);
    seedMat.dispose();
  }

  // ---------- mount ----------

  onMounted(() => {
    // 1. Тёмный фон, без блика на канвасе.
    bgColor3.set(params.bgColor);
    renderer.value.setClearColor(bgColor3, 1);

    // 2. GPGPU инфраструктура.
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadScene = new THREE.Scene();
    quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quadScene.add(quadMesh);

    simRTA = createSimRT();
    simRTB = createSimRT();
    defaultPosTex = createDefaultPosTexture();
    blueNoiseTex = createBlueNoiseTexture(128);

    seedSimulation();

    simMaterial = new THREE.RawShaderMaterial({
      uniforms: {
        u_simPrevPosLifeTexture: { value: simRTA.texture },
        u_simDefaultPosLifeTexture: { value: defaultPosTex },
        u_introDeltaTime: { value: 0 },
        u_noiseTime: { value: 0 },
        u_noiseScale: { value: 0 },
        u_noiseStableFactor: { value: 0 },
        u_spinStrength: { value: params.spinStrength },
        u_curlStrength: { value: params.curlStrength },
        u_lifeDecaySpeed: { value: params.lifeDecaySpeed },
        u_lightPosition: { value: new THREE.Vector3(params.lightX, params.lightY, params.lightZ) },
      },
      vertexShader: 'in vec3 position;\nin vec2 uv;\nout vec2 v_uv;\nvoid main(){v_uv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader:
        'precision highp float;\nout vec4 fragColor;\nin vec2 v_uv;\n' +
        FS_SIMULATION.replace('precision highp float;', '')
          .replace('varying vec2 v_uv;', '')
          .replace(/gl_FragColor/g, 'fragColor')
          .replace(/texture2D/g, 'texture'),
      glslVersion: THREE.GLSL3,
    });

    // 3. Геометрия частиц. Делим simUv-атлас на две группы:
    // emissive — только колонка x=0 (по одной частице на строку, всего SIM_H штук),
    // non-emissive — все остальные.
    const emissiveUv = new Float32Array(SIM_H * 2);
    const nonEmissiveUv = new Float32Array((SIM_W - 1) * SIM_H * 2);
    for (let y = 0, ei = 0, ni = 0; y < SIM_H; y++) {
      const v = (y + 0.5) / SIM_H;
      for (let x = 0; x < SIM_W; x++) {
        const u = (x + 0.5) / SIM_W;
        if (x === 0) {
          emissiveUv[ei++] = u;
          emissiveUv[ei++] = v;
        } else {
          nonEmissiveUv[ni++] = u;
          nonEmissiveUv[ni++] = v;
        }
      }
    }

    baseColor3.set(params.baseColor);
    emissiveColor3.set(params.emissiveColor);

    // Базовая сфера. SphereGeometry(1) — единичный радиус, дальше масштабируется
    // в шейдере по simUv-индексу и life-маске.
    const sphereGeom = new THREE.SphereGeometry(1, params.sphereSegments, Math.max(4, params.sphereSegments - 2));

    const makeInstancedGeom = (uvs) => {
      // Клонируем sphereGeom, чтобы каждая инстанс-группа имела свои BufferAttribute —
      // shared attributes между InstancedBufferGeometry и обычной геометрией могут
      // путать three.js при определении instanceCount.
      const cloned = sphereGeom.clone();
      const ig = new THREE.InstancedBufferGeometry();
      ig.setIndex(cloned.index);
      ig.setAttribute('position', cloned.attributes.position);
      ig.setAttribute('normal', cloned.attributes.normal);
      ig.setAttribute('uv', cloned.attributes.uv);
      ig.setAttribute('simUv', new THREE.InstancedBufferAttribute(uvs, 2));
      ig.instanceCount = uvs.length / 2;
      ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
      return ig;
    };

    // Общие uniform-объекты — emissive/non-emissive материалы их шарят, чтобы
    // изменение в GUI применялось к обоим одновременно.
    const sharedUniforms = {
      u_simCurrPosLifeTexture: { value: simRTB.texture },
      u_sceneHideRatio: { value: 0 },
      u_sizeEmissive: { value: params.sizeEmissive },
      u_sizeNonEmissive: { value: params.sizeNonEmissive },
      u_lightPosition: simMaterial.uniforms.u_lightPosition,
      u_baseColor: { value: baseColor3 },
      u_emissiveColor: { value: emissiveColor3 },
      u_blueNoiseTexture: { value: blueNoiseTex },
      u_blueNoiseTexelSize: { value: new THREE.Vector2(1 / 128, 1 / 128) },
      u_blueNoiseCoordOffset: { value: new THREE.Vector2() },
      u_lightScatterDivider: { value: new THREE.Vector2(1.1, 5.5) },
      u_lightScatterPowInv: { value: 0.7 },
      u_lightScatterRatio: { value: params.scatterEnabled ? params.scatterRatio : 0 },
      u_lightScatterPos0: { value: new THREE.Vector3(0, 4, 0) },
      u_lightScatterPos1: { value: new THREE.Vector3(0, -4, 0) },
    };

    const makeMaterial = (isEmissive) =>
      new THREE.ShaderMaterial({
        uniforms: { ...sharedUniforms, u_isEmissive: { value: isEmissive ? 1 : 0 } },
        vertexShader: VS_PARTICLES,
        fragmentShader: FS_PARTICLES,
      });

    nonEmissiveMesh = new THREE.Mesh(makeInstancedGeom(nonEmissiveUv), makeMaterial(false));
    emissiveMesh = new THREE.Mesh(makeInstancedGeom(emissiveUv), makeMaterial(true));
    nonEmissiveMesh.frustumCulled = false;
    emissiveMesh.frustumCulled = false;
    scene.value.add(nonEmissiveMesh);
    scene.value.add(emissiveMesh);

    // Пред-прогрев симуляции: 90 шагов по 1/30 сек ≈ 3 секунды виртуального времени,
    // чтобы первая видимая фрейма уже содержала живое облако, а не пустоту.
    // Без него первые ~2 секунды частицы только-только начинают респауниться (life стартует ∈ [-1, 0]).
    {
      const warmDt = 1 / 30;
      simMaterial.uniforms.u_introDeltaTime.value = warmDt;
      simMaterial.uniforms.u_noiseStableFactor.value = 0;
      simMaterial.uniforms.u_lightPosition.value.set(params.lightX, params.lightY, params.lightZ);
      for (let step = 0; step < 90; step++) {
        noiseTime += warmDt * params.noiseSpeed;
        simMaterial.uniforms.u_noiseTime.value = noiseTime;
        simMaterial.uniforms.u_noiseScale.value = step < 5 ? 0 : 5;
        const tmp = simRTA;
        simRTA = simRTB;
        simRTB = tmp;
        simMaterial.uniforms.u_simPrevPosLifeTexture.value = simRTA.texture;
        renderToTarget(simMaterial, simRTB);
      }
      // После прогрева читать частицы из simRTB.
      nonEmissiveMesh.material.uniforms.u_simCurrPosLifeTexture.value = simRTB.texture;
      emissiveMesh.material.uniforms.u_simCurrPosLifeTexture.value = simRTB.texture;
    }

    // 4. Tick: симуляция → рендер. На каждом кадре:
    // - копим introTime/noiseTime
    // - считаем noiseScale и stableFactor через 1D-FBM (как в исходнике)
    // - свапаем simRTA/simRTB, рендерим симуляцию
    // - обновляем uniform-ы рендер-материалов
    onTick((dt) => {
      if (params.paused) return;

      // Auto intro: монотонно поднимаем introRatio с 0 до 1 за ~6 секунд.
      if (params.autoIntro && params.introRatio < 1) {
        params.introRatio = saturate(params.introRatio + dt / 6);
      }

      // Управляющие шумы (порт из AboutHeroParticlesSimulation.update).
      noiseTime += dt * params.noiseSpeed;
      noiseScaleTime += dt;
      const fbm = noiseScaleNoise.getFbm(noiseScaleTime, 3);
      noiseScale = 10 * Math.abs(fbm);

      noiseStableFactorTime += dt * 0.5;
      noiseStableFactorAcc += 0.05 * Math.abs(noiseStableNoise.getFbm(noiseStableFactorTime, 3));
      stableFactor = fit(params.introRatio, 0, 0.4, 0, 1) * smoothstep01(0.9, 0.95, 0.5 + 0.5 * Math.sin(noiseStableFactorAcc));

      // Лёгкое демпфирование dt для повышения визуальной устойчивости.
      const simDt = Math.min(dt, 1 / 30);

      // Симуляция: ping-pong.
      const tmp = simRTA;
      simRTA = simRTB;
      simRTB = tmp;

      simMaterial.uniforms.u_simPrevPosLifeTexture.value = simRTA.texture;
      simMaterial.uniforms.u_introDeltaTime.value = simDt;
      simMaterial.uniforms.u_noiseTime.value = noiseTime;
      simMaterial.uniforms.u_noiseScale.value = noiseScale;
      simMaterial.uniforms.u_noiseStableFactor.value = stableFactor;
      simMaterial.uniforms.u_spinStrength.value = params.spinStrength;
      simMaterial.uniforms.u_curlStrength.value = params.curlStrength;
      simMaterial.uniforms.u_lifeDecaySpeed.value = params.lifeDecaySpeed;
      simMaterial.uniforms.u_lightPosition.value.set(params.lightX, params.lightY, params.lightZ);

      renderToTarget(simMaterial, simRTB);

      // Обновляем uniform-ы для рендера частиц.
      nonEmissiveMesh.material.uniforms.u_simCurrPosLifeTexture.value = simRTB.texture;
      emissiveMesh.material.uniforms.u_simCurrPosLifeTexture.value = simRTB.texture;

      // Per-frame rotate blue-noise offset, чтобы зерно не залипало.
      sharedUniforms.u_blueNoiseCoordOffset.value.set(Math.random() * 2, Math.random() * 2);
      // Hide ratio: для standalone-демо отключён (в исходнике это OUT-фаза при scroll-end).
      // Если введут анимацию intro 0..1 — можно включить fit(introRatio, 0.85, 1, 0, 1).
      sharedUniforms.u_sceneHideRatio.value = 0;
      // Size — берём прямо из params.
      sharedUniforms.u_sizeEmissive.value = params.sizeEmissive;
      sharedUniforms.u_sizeNonEmissive.value = params.sizeNonEmissive;
      sharedUniforms.u_lightScatterRatio.value = params.scatterEnabled ? params.scatterRatio : 0;
    });

    // 5. GUI.
    setupGui();
  });

  function setupGui() {
    gui = new GUI({ title: 'Vortex' });

    // Перезапуск перемонтирует компонент через слушатель в [slug].vue.
    const actions = {
      restart: () => window.dispatchEvent(new CustomEvent('effect-restart')),
    };
    gui.add(actions, 'restart').name('перезапуск');

    gui.add(params, 'introRatio', 0, 1, 0.001).name('intro');
    gui.add(params, 'autoIntro').name('auto-intro');
    gui.add(params, 'paused').name('pause');

    const fSim = gui.addFolder('simulation');
    fSim.add(params, 'noiseSpeed', 0, 2, 0.01).name('noise speed');
    fSim.add(params, 'spinStrength', 0, 3, 0.01).name('spin');
    fSim.add(params, 'curlStrength', 0, 3, 0.01).name('curl');
    fSim.add(params, 'lifeDecaySpeed', 0.1, 3, 0.01).name('life decay');

    const fLight = gui.addFolder('center');
    fLight.add(params, 'lightX', -3, 3, 0.01).name('x');
    fLight.add(params, 'lightY', -3, 3, 0.01).name('y');
    fLight.add(params, 'lightZ', -3, 3, 0.01).name('z');

    const fLook = gui.addFolder('look');
    fLook
      .addColor(params, 'bgColor')
      .name('background')
      .onChange((v) => {
        bgColor3.set(v);
        renderer.value.setClearColor(bgColor3, 1);
      });
    fLook
      .addColor(params, 'baseColor')
      .name('non-emissive')
      .onChange((v) => baseColor3.set(v));
    fLook
      .addColor(params, 'emissiveColor')
      .name('emissive')
      .onChange((v) => emissiveColor3.set(v));
    fLook.add(params, 'sizeNonEmissive', 0.005, 0.2, 0.001).name('size base');
    fLook.add(params, 'sizeEmissive', 0.02, 0.4, 0.001).name('size glow');

    const fScatter = gui.addFolder('scatter');
    fScatter.add(params, 'scatterEnabled').name('enabled');
    fScatter.add(params, 'scatterRatio', 0, 2, 0.01).name('intensity');

    fSim.close();
    fLight.close();
    fLook.close();
    fScatter.close();
  }

  // ---------- dispose ----------

  onBeforeUnmount(() => {
    gui?.destroy();
    nonEmissiveMesh?.geometry.dispose();
    nonEmissiveMesh?.material.dispose();
    emissiveMesh?.geometry.dispose();
    emissiveMesh?.material.dispose();
    quadMesh?.geometry.dispose();
    simMaterial?.dispose();
    simRTA?.dispose();
    simRTB?.dispose();
    defaultPosTex?.dispose();
    blueNoiseTex?.dispose();
  });
</script>

<style lang="scss" scoped>
  .about-hero-vortex {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
