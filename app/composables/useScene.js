import * as THREE from 'three';

/**
 * Базовая three.js сцена для экспериментов: renderer + scene + camera + clock + RAF-цикл.
 *
 * Берёт на себя бойлерплейт: инициализация WebGLRenderer, resize по контейнеру, pixel ratio,
 * tracking мыши, dispose при unmount. Всё инициализируется в onMounted — SSR-safe.
 *
 * ВАЖНО: three-инстансы лежат в shallowRef, а НЕ в ref. Делать их глубоко-реактивными нельзя:
 * Vue-проксирование ломает внутренности three (matrix updates, dirty flags) и сильно просаживает перф.
 *
 * @param {Ref<HTMLCanvasElement>} canvasRef — template ref на <canvas>
 * @param {object} [options]
 * @param {'perspective'|'orthographic'} [options.cameraType='perspective']
 * @param {number} [options.fov=50]
 * @param {number} [options.near=0.1]
 * @param {number} [options.far=100]
 * @param {[number,number,number]} [options.cameraPosition=[0,0,3]]
 * @param {boolean} [options.alpha=false] — прозрачный canvas
 * @param {boolean} [options.antialias=true]
 * @param {number|string} [options.clearColor=0x000000]
 * @param {number} [options.clearAlpha=1]
 * @param {number} [options.pixelRatioLimit=2] — потолок devicePixelRatio (на ретине выше 2 обычно не имеет смысла)
 * @param {boolean} [options.autoStart=true] — автостарт RAF-цикла после mount
 *
 * @returns {{
 *   scene: ShallowRef<THREE.Scene>,
 *   camera: ShallowRef<THREE.Camera>,
 *   renderer: ShallowRef<THREE.WebGLRenderer>,
 *   clock: ShallowRef<THREE.Clock>,
 *   size: { width: number, height: number },
 *   mouse: { x: number, y: number },
 *   onTick: (cb: (dt: number, elapsed: number) => void) => () => void,
 *   onResize: (cb: (size: { width: number, height: number }) => void) => () => void,
 *   start: () => void,
 *   stop: () => void,
 * }}
 *
 * @example
 *   const canvas = ref(null);
 *   const { scene, camera, onTick } = useScene(canvas);
 *
 *   onMounted(() => {
 *     const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshNormalMaterial());
 *     scene.value.add(mesh);
 *     onTick((dt) => { mesh.rotation.y += dt; });
 *   });
 */
export function useScene(canvasRef, options = {}) {
  const {
    cameraType = 'perspective',
    fov = 50,
    near = 0.1,
    far = 100,
    cameraPosition = [0, 0, 3],
    alpha = false,
    antialias = true,
    clearColor = 0x000000,
    clearAlpha = 1,
    pixelRatioLimit = 2,
    autoStart = true,
  } = options;

  const scene = shallowRef(null);
  const camera = shallowRef(null);
  const renderer = shallowRef(null);
  const clock = shallowRef(null);

  // Размер и мышь — обычный reactive, читается из шаблонов/uniform-обновлений
  const size = reactive({ width: 0, height: 0 });
  // mouse.x, mouse.y в [0..1] с левым-нижним началом координат (как у texture uv)
  const mouse = reactive({ x: 0.5, y: 0.5 });

  const tickCallbacks = new Set();
  const resizeCallbacks = new Set();

  const onTick = (cb) => {
    tickCallbacks.add(cb);
    return () => tickCallbacks.delete(cb);
  };
  const onResize = (cb) => {
    resizeCallbacks.add(cb);
    return () => resizeCallbacks.delete(cb);
  };

  let rafId = null;
  let disposed = false;

  const loop = () => {
    if (disposed) return;
    const dt = clock.value.getDelta();
    const elapsed = clock.value.getElapsedTime();
    tickCallbacks.forEach((cb) => cb(dt, elapsed));
    renderer.value.render(scene.value, camera.value);
    rafId = requestAnimationFrame(loop);
  };

  const start = () => {
    if (rafId || disposed || !clock.value) return;
    clock.value.start();
    rafId = requestAnimationFrame(loop);
  };

  const stop = () => {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = null;
    clock.value?.stop();
  };

  // Контейнер для замера размера — родитель canvas. Если canvas напрямую во flex/grid без
  // явных размеров, getBoundingClientRect даст 0x0 — делай контейнеру height/width в CSS.
  const getContainer = () => canvasRef.value?.parentElement ?? canvasRef.value;

  const handleResize = () => {
    const container = getContainer();
    if (!container || !renderer.value) return;
    const rect = container.getBoundingClientRect();
    size.width = rect.width;
    size.height = rect.height;
    // false — не обновляем style canvas (CSS-размер задаёт контейнер, WebGL меняет только буфер)
    renderer.value.setSize(rect.width, rect.height, false);
    if (camera.value.isPerspectiveCamera) {
      camera.value.aspect = rect.width / rect.height;
      camera.value.updateProjectionMatrix();
    }
    resizeCallbacks.forEach((cb) => cb({ width: rect.width, height: rect.height }));
  };

  const handlePointerMove = (e) => {
    const canvas = canvasRef.value;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - rect.left) / rect.width;
    mouse.y = 1 - (e.clientY - rect.top) / rect.height;
  };

  onMounted(() => {
    const canvas = canvasRef.value;
    if (!canvas) return;

    renderer.value = new THREE.WebGLRenderer({ canvas, alpha, antialias });
    renderer.value.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioLimit));
    renderer.value.setClearColor(clearColor, clearAlpha);

    scene.value = new THREE.Scene();

    const rect = getContainer().getBoundingClientRect();
    if (cameraType === 'perspective') {
      camera.value = new THREE.PerspectiveCamera(fov, rect.width / rect.height || 1, near, far);
    } else {
      // Ортокамера с aspect-ratio — настраивается в handleResize через custom onResize, если нужно
      camera.value = new THREE.OrthographicCamera(-1, 1, 1, -1, near, far);
    }
    camera.value.position.set(...cameraPosition);
    camera.value.lookAt(0, 0, 0);

    clock.value = new THREE.Clock(false);

    handleResize();
    window.addEventListener('resize', handleResize);
    canvas.addEventListener('pointermove', handlePointerMove);

    if (autoStart) start();
  });

  onBeforeUnmount(() => {
    disposed = true;
    stop();
    window.removeEventListener('resize', handleResize);
    const canvas = canvasRef.value;
    if (canvas) canvas.removeEventListener('pointermove', handlePointerMove);
    if (renderer.value) {
      renderer.value.dispose();
      // forceContextLoss освобождает WebGL-контекст: браузеры держат лимит (~16 активных),
      // без этого при hot-reload / навигации быстро упираемся в "Too many active WebGL contexts"
      renderer.value.forceContextLoss?.();
    }
    tickCallbacks.clear();
    resizeCallbacks.clear();
  });

  return {
    scene,
    camera,
    renderer,
    clock,
    size,
    mouse,
    onTick,
    onResize,
    start,
    stop,
  };
}
