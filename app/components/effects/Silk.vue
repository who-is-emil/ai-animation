<!--
  Шёлковое полотно с холмиками.

  Геометрия — PlaneGeometry в локальном XY-plane, повёрнута на меше (rotation.x = -π/2)
  в горизонтальное положение (мировой XZ-plane, нормаль +Y). Так полотно лежит
  «как скатерть»: «вверх» совпадает с мировым +Y, холмики растут естественно.

  Холмики считаются в vertex-shader как simplex 3D от адвектируемых координат →
  смещение pos.z (которое после mesh-поворота уезжает в мировой +Y). Цвет в
  fragment-shader: mix(low, high, smoothstep(...)) от нормализованной высоты.
  Освещение не используется — обе стороны плоскости красятся одинаково (DoubleSide).

  Полотно полупрозрачное через uOpacity. Чтобы сквозь переднюю складку была видна
  задняя, отключён depthWrite — иначе depth-буфер обрезает дальние фрагменты при
  transparent: true и эффект «сквозь» не работает.
-->
<template>
  <canvas ref="canvas" class="silk" />
</template>

<script setup>
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import GUI from 'lil-gui';

  const canvas = ref(null);

  const { scene, camera, renderer, onTick } = useScene(canvas, {
    fov: 45,
    near: 0.01,
    far: 100,
    cameraPosition: [0, 0, 2.5],
    clearColor: 0x0e0e12,
  });

  const PLANE_W = 8;
  const PLANE_H = 2;

  // Все художественные параметры в одном объекте — удобно для onChange и Log params.
  // Структурные (segmentsX/Y) не вынесены в GUI: пересоздание геометрии на лету
  // не нужно для подбора визуала, дефолты подобраны для гладкости.
  const params = {
    // Шаг сетки сохраняем ~0.02 world units: при PLANE_W=8 берём 400 сегментов по X.
    segmentsX: 400,
    segmentsY: 100,
    // Холмики (бегущая волна на основе адвекции simplex 3D)
    amplitudeHill: 0.19,
    noiseFreq: 0.7,
    flowSpeed: 0.1,
    flowAngle: 0, // направление потока в градусах: 0 — слева направо, 90 — снизу вверх
    // Цвет / отображение
    colorHigh: '#b63e3e',
    colorLow: '#000000',
    bgColor: '#0e0e12',
    contrast: 1.75,
    opacity: 0.75,
    // Свет (мягкий направленный + ambient + specular)
    lightAzimuth: 267, // горизонтальный угол в градусах
    lightElevation: 0, // высота над горизонтом в градусах
    lightColor: '#b63e3e', // цвет источника (применяется к diffuse и specular)
    lightIntensity: 1.2,
    ambient: 1, // доля «заполняющего» света (0 — полный контраст, 1 — без теней)
    specStrength: 1,
    shininess: 72, // степень блеска: больше — пятно блика мельче и резче
    // Rim (Fresnel-светимость на скользящих углах) — распределённое свечение по всему полотну,
    // не зависит от направления света. Чем больше rimPower, тем уже «кайма» по краям нормалей.
    rimColor: '#b63e3e',
    rimStrength: 2,
    rimPower: 8,
    // Камера: distance — расстояние от camera.position до controls.target.
    // Реальное значение проставляется в onMounted после создания controls (производная от cameraPosition).
    distance: 10,
    // Объект (transform меша). Дефолтный rotX = -π/2 — полотно лежит горизонтально (XZ plane).
    meshPosX: 0,
    meshPosY: 0,
    meshPosZ: 0,
    meshRotX: -Math.PI / 2,
    meshRotY: 0,
    meshRotZ: 0,
  };

  let mesh = null;
  let material = null;
  let geometry = null;
  let controls = null;
  let gui = null;

  // Конвертация (azimuth, elevation в градусах) → нормализованный вектор направления света
  // в world space. azimuth=0 — свет светит со стороны +X, elevation=90 — строго сверху.
  // Возвращаемый вектор указывает ОТ сцены К источнику (для расчёта L = normalize(uLightDir)
  // в формулах освещения).
  function lightDirFromAngles(azDeg, elDeg) {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  }

  // 3D Simplex noise — Stefan Gustavson / Ashima Arts, public domain.
  // Подмешиваем в vertex-shader строкой; вынос в .glsl-файл нужен только при шаринге между эффектами.
  const SIMPLEX_3D = /* glsl */ `
    vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + 1.0 * C.xxx;
      vec3 x2 = x0 - i2 + 2.0 * C.xxx;
      vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
      i = mod(i, 289.0);
      vec4 p = permute(permute(permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 1.0 / 7.0;
      vec3  ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }
  `;

  const VERTEX_SHADER = /* glsl */ `
    ${SIMPLEX_3D}

    uniform float uTime;
    uniform float uAmplitudeHill;
    uniform float uNoiseFreq;
    uniform float uFlowSpeed;
    uniform float uFlowAngle; // в радианах

    varying float vNormalizedHeight;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;

    // Высота в произвольной точке (xy) — нужна и для смещения, и для аналитической нормали.
    float computeHeight(vec2 xy, float t) {
      vec2 dir = vec2(cos(uFlowAngle), sin(uFlowAngle));
      vec3 noiseUV = vec3(
        (xy.x - t * uFlowSpeed * dir.x) * uNoiseFreq,
        (xy.y - t * uFlowSpeed * dir.y) * uNoiseFreq,
        t * uFlowSpeed * 0.3
      );
      return snoise(noiseUV) * uAmplitudeHill;
    }

    void main() {
      vec3 pos = position;

      float h = computeHeight(pos.xy, uTime);
      pos.z += h;

      // Аналитическая нормаль через градиент шума: дёшево, гладко, лучше dFdx (он бы дал
      // фасеточные нормали по треугольникам). eps — мелкий шаг в координатах ткани.
      float eps = 0.01;
      float h_dx = computeHeight(pos.xy + vec2(eps, 0.0), uTime);
      float h_dy = computeHeight(pos.xy + vec2(0.0, eps), uTime);
      vec3 normalLocal = normalize(vec3(-(h_dx - h) / eps, -(h_dy - h) / eps, 1.0));

      // World-space нормаль и позиция — для освещения в fragment-shader.
      // mat3(modelMatrix) корректен при scale=1 (у нас так), иначе нужен normalMatrix.
      vWorldNormal = normalize(mat3(modelMatrix) * normalLocal);
      vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;

      // Нормализация высоты в [0..1] для цветового градиента.
      float maxAmp = uAmplitudeHill + 1e-4;
      vNormalizedHeight = clamp((h + maxAmp) / (2.0 * maxAmp), 0.0, 1.0);

      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;

  const FRAGMENT_SHADER = /* glsl */ `
    precision highp float;

    uniform vec3 uColorLow;
    uniform vec3 uColorHigh;
    uniform float uContrast;
    uniform float uOpacity;

    uniform vec3 uLightDir;       // в world space, нормализован, направлен ОТ источника на сцену
    uniform vec3 uLightColor;     // цвет источника (для diffuse и specular)
    uniform float uLightIntensity;
    uniform float uAmbient;       // 0..1: 0 — полный контраст, 1 — без теней
    uniform float uSpecStrength;
    uniform float uShininess;

    uniform vec3 uRimColor;
    uniform float uRimStrength;
    uniform float uRimPower;

    varying float vNormalizedHeight;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;

    void main() {
      // Базовый цвет от высоты.
      float edge = 0.5 / max(uContrast, 0.05);
      float t = smoothstep(0.5 - edge, 0.5 + edge, vNormalizedHeight);
      vec3 col = mix(uColorLow, uColorHigh, t);

      // Освещение в world space.
      // DoubleSide: на back-face нормаль смотрит «внутрь», для физичного освещения переворачиваем.
      vec3 N = normalize(vWorldNormal);
      if (!gl_FrontFacing) N = -N;

      vec3 L = normalize(uLightDir);
      vec3 V = normalize(cameraPosition - vWorldPos);
      vec3 R = reflect(-L, N);

      float diff = max(dot(N, L), 0.0);
      float spec = pow(max(dot(R, V), 0.0), max(uShininess, 1.0));

      // Rim (Fresnel): зависит только от угла между нормалью и взглядом — даёт распределённое
      // свечение там, где поверхность смотрит под скользящим углом. При движении волн мерцает
      // по всему полотну, в отличие от specular hot-spot.
      float rim = pow(1.0 - max(dot(N, V), 0.0), max(uRimPower, 0.1));

      // Декомпозиция:
      //   ambient — белая «заливка» в цвете полотна (тени не уходят в чёрный),
      //   diffuse — направленная составляющая, окрашена цветом источника,
      //   specular — концентрированный блик в цвете источника,
      //   rim     — распределённое свечение в собственном цвете rim.
      vec3 ambientPart = col * uAmbient;
      vec3 diffusePart = col * uLightColor * (1.0 - uAmbient) * diff * uLightIntensity;
      vec3 specPart = uLightColor * spec * uSpecStrength * uLightIntensity;
      vec3 rimPart = uRimColor * rim * uRimStrength;
      vec3 lit = ambientPart + diffusePart + specPart + rimPart;

      gl_FragColor = vec4(lit, uOpacity);
    }
  `;

  onMounted(() => {
    geometry = new THREE.PlaneGeometry(PLANE_W, PLANE_H, params.segmentsX, params.segmentsY);

    material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      // transparent + depthWrite:false — обязательная пара для «сквозной» полупрозрачности:
      // depthWrite:true обрезал бы дальние складки полотна по z-буферу даже при opacity<1,
      // и эффект «сквозь переднюю волну видно заднюю» не работал бы.
      transparent: true,
      depthWrite: false,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uAmplitudeHill: { value: params.amplitudeHill },
        uNoiseFreq: { value: params.noiseFreq },
        uFlowSpeed: { value: params.flowSpeed },
        uFlowAngle: { value: (params.flowAngle * Math.PI) / 180 },
        uColorLow: { value: new THREE.Color(params.colorLow) },
        uColorHigh: { value: new THREE.Color(params.colorHigh) },
        uContrast: { value: params.contrast },
        uOpacity: { value: params.opacity },
        uLightDir: { value: lightDirFromAngles(params.lightAzimuth, params.lightElevation) },
        uLightColor: { value: new THREE.Color(params.lightColor) },
        uLightIntensity: { value: params.lightIntensity },
        uAmbient: { value: params.ambient },
        uSpecStrength: { value: params.specStrength },
        uShininess: { value: params.shininess },
        uRimColor: { value: new THREE.Color(params.rimColor) },
        uRimStrength: { value: params.rimStrength },
        uRimPower: { value: params.rimPower },
      },
    });

    mesh = new THREE.Mesh(geometry, material);
    // Поворот меша даёт горизонтальную ориентацию (см. params.meshRotX дефолт = -π/2).
    // Поворот делаем на меше, а не на геометрии — vertex-shader продолжает работать в local space
    // (pos.x, pos.y — координаты на полотне; смещение по pos.z уезжает в мировой +Y).
    mesh.position.set(params.meshPosX, params.meshPosY, params.meshPosZ);
    mesh.rotation.set(params.meshRotX, params.meshRotY, params.meshRotZ);
    scene.value.add(mesh);

    // OrbitControls без ограничений по углу: можно перевернуть полотно и смотреть снизу.
    // Pan отключен — иначе при панорамировании теряется центр и orbit становится странным.
    controls = new OrbitControls(camera.value, renderer.value.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 30;
    // Дефолтный distance — производная от стартовой cameraPosition, синхронизируем в params
    // ДО создания GUI, чтобы слайдер показал правильное стартовое значение.
    params.distance = camera.value.position.distanceTo(controls.target);

    onTick((_dt, elapsed) => {
      material.uniforms.uTime.value = elapsed;
      controls.update();
    });

    gui = new GUI({ title: 'Шёлк' });

    // Лог в консоль — удобно зафиксировать пресет перед коммитом дефолтов.
    // logParams: художественные параметры. logCamera: живая позиция камеры и target OrbitControls
    // (округление до 3 знаков — достаточно для подгонки ракурса).
    const round3 = (v) => Math.round(v * 1000) / 1000;
    const actions = {
      logParams: () => {
        // eslint-disable-next-line no-console
        console.log(JSON.parse(JSON.stringify(params)));
      },
      logCamera: () => {
        const p = camera.value.position;
        const t = controls.target;
        const distance = p.distanceTo(t);
        // eslint-disable-next-line no-console
        console.log({
          cameraPosition: [round3(p.x), round3(p.y), round3(p.z)],
          controlsTarget: [round3(t.x), round3(t.y), round3(t.z)],
          distance: round3(distance),
        });
      },
      logMesh: () => {
        const p = mesh.position;
        const r = mesh.rotation;
        // eslint-disable-next-line no-console
        console.log({
          meshPosition: [round3(p.x), round3(p.y), round3(p.z)],
          meshRotation: [round3(r.x), round3(r.y), round3(r.z)],
        });
      },
      logColors: () => {
        // eslint-disable-next-line no-console
        console.log({
          colorHigh: params.colorHigh,
          colorLow: params.colorLow,
          bgColor: params.bgColor,
          lightColor: params.lightColor,
          rimColor: params.rimColor,
        });
      },
    };
    gui.add(actions, 'logParams').name('Log params');
    gui.add(actions, 'logCamera').name('Log camera');
    gui.add(actions, 'logMesh').name('Log mesh');
    gui.add(actions, 'logColors').name('Log colors');

    const cameraFolder = gui.addFolder('Камера');
    // Зум через слайдер: вычисляем текущее направление от target к камере, нормализуем
    // и масштабируем на новый distance. Если камера ровно в target (lengthSq ≈ 0) — выходим,
    // иначе normalize даст NaN.
    const distanceController = cameraFolder
      .add(params, 'distance', 1.5, 30, 0.05)
      .name('зум (distance)')
      .onChange((v) => {
        const dir = camera.value.position.clone().sub(controls.target);
        if (dir.lengthSq() < 1e-6) return;
        dir.normalize().multiplyScalar(v);
        camera.value.position.copy(controls.target).add(dir);
        controls.update();
      });

    // Обратная синхронизация: при крутке мыши/колеса OrbitControls дёргает 'change',
    // обновляем params.distance и принудительно перерисовываем слайдер.
    controls.addEventListener('change', () => {
      params.distance = camera.value.position.distanceTo(controls.target);
      distanceController.updateDisplay();
    });

    // Объект (полотно): позиция и поворот меша. Слайдеры биндятся напрямую на mesh.position
    // и mesh.rotation, three.js сам пересчитает matrixWorld на следующем кадре.
    const meshFolder = gui.addFolder('Объект');
    meshFolder.add(params, 'meshPosX', -5, 5, 0.01).name('pos x').onChange((v) => {
      mesh.position.x = v;
    });
    meshFolder.add(params, 'meshPosY', -5, 5, 0.01).name('pos y').onChange((v) => {
      mesh.position.y = v;
    });
    meshFolder.add(params, 'meshPosZ', -5, 5, 0.01).name('pos z').onChange((v) => {
      mesh.position.z = v;
    });
    meshFolder.add(params, 'meshRotX', -Math.PI, Math.PI, 0.01).name('rot x').onChange((v) => {
      mesh.rotation.x = v;
    });
    meshFolder.add(params, 'meshRotY', -Math.PI, Math.PI, 0.01).name('rot y').onChange((v) => {
      mesh.rotation.y = v;
    });
    meshFolder.add(params, 'meshRotZ', -Math.PI, Math.PI, 0.01).name('rot z').onChange((v) => {
      mesh.rotation.z = v;
    });

    const hillFolder = gui.addFolder('Холмики');
    hillFolder
      .add(params, 'amplitudeHill', 0, 0.3, 0.005)
      .name('амплитуда')
      .onChange((v) => {
        material.uniforms.uAmplitudeHill.value = v;
      });
    hillFolder
      .add(params, 'noiseFreq', 0.5, 6, 0.05)
      .name('частота шума')
      .onChange((v) => {
        material.uniforms.uNoiseFreq.value = v;
      });
    hillFolder
      .add(params, 'flowSpeed', 0, 3, 0.01)
      .name('скорость волны')
      .onChange((v) => {
        material.uniforms.uFlowSpeed.value = v;
      });
    hillFolder
      .add(params, 'flowAngle', 0, 360, 1)
      .name('направление (°)')
      .onChange((deg) => {
        material.uniforms.uFlowAngle.value = (deg * Math.PI) / 180;
      });

    const colorFolder = gui.addFolder('Цвет');
    colorFolder
      .addColor(params, 'colorHigh')
      .name('вершины (золото)')
      .onChange((v) => {
        material.uniforms.uColorHigh.value.set(v);
      });
    colorFolder
      .addColor(params, 'colorLow')
      .name('низины (основа)')
      .onChange((v) => {
        material.uniforms.uColorLow.value.set(v);
      });
    colorFolder
      .addColor(params, 'bgColor')
      .name('фон')
      .onChange((v) => {
        renderer.value.setClearColor(new THREE.Color(v));
      });
    colorFolder
      .add(params, 'contrast', 0.2, 2, 0.05)
      .name('контраст градиента')
      .onChange((v) => {
        material.uniforms.uContrast.value = v;
      });
    colorFolder
      .add(params, 'opacity', 0, 1, 0.01)
      .name('прозрачность')
      .onChange((v) => {
        material.uniforms.uOpacity.value = v;
      });

    const lightFolder = gui.addFolder('Свет');
    const updateLightDir = () => {
      material.uniforms.uLightDir.value.copy(lightDirFromAngles(params.lightAzimuth, params.lightElevation));
    };
    lightFolder.add(params, 'lightAzimuth', 0, 360, 1).name('азимут (°)').onChange(updateLightDir);
    lightFolder.add(params, 'lightElevation', 0, 90, 1).name('высота (°)').onChange(updateLightDir);
    lightFolder
      .addColor(params, 'lightColor')
      .name('цвет света')
      .onChange((v) => {
        material.uniforms.uLightColor.value.set(v);
      });
    lightFolder
      .add(params, 'lightIntensity', 0, 2, 0.01)
      .name('яркость')
      .onChange((v) => {
        material.uniforms.uLightIntensity.value = v;
      });
    lightFolder
      .add(params, 'ambient', 0, 1, 0.01)
      .name('ambient (заполнение)')
      .onChange((v) => {
        material.uniforms.uAmbient.value = v;
      });
    lightFolder
      .add(params, 'specStrength', 0, 2, 0.01)
      .name('сила бликов')
      .onChange((v) => {
        material.uniforms.uSpecStrength.value = v;
      });
    lightFolder
      .add(params, 'shininess', 1, 128, 1)
      .name('резкость бликов')
      .onChange((v) => {
        material.uniforms.uShininess.value = v;
      });
    lightFolder
      .addColor(params, 'rimColor')
      .name('rim — цвет')
      .onChange((v) => {
        material.uniforms.uRimColor.value.set(v);
      });
    lightFolder
      .add(params, 'rimStrength', 0, 2, 0.01)
      .name('rim — сила')
      .onChange((v) => {
        material.uniforms.uRimStrength.value = v;
      });
    lightFolder
      .add(params, 'rimPower', 0.5, 8, 0.05)
      .name('rim — резкость')
      .onChange((v) => {
        material.uniforms.uRimPower.value = v;
      });

    // Все папки свёрнуты — кнопка Log params остаётся видимой в шапке GUI.
    gui.folders.forEach((f) => f.close());
  });

  onBeforeUnmount(() => {
    gui?.destroy();
    controls?.dispose();
    geometry?.dispose();
    material?.dispose();
  });
</script>

<style lang="scss" scoped>
  .silk {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
