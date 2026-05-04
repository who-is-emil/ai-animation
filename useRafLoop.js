/**
 * Низкоуровневый RAF-цикл для экспериментов вне three-сцены (DOM-анимации, канвас 2D и т.д.).
 *
 * Внутри three-сцены используй onTick из useScene — там tick синхронизирован с рендером.
 *
 * @param {(dt: number, elapsed: number) => void} callback — вызывается на каждом кадре
 *   dt — секунды с прошлого кадра, elapsed — секунды с момента старта
 * @param {{ autoStart?: boolean }} [options]
 *
 * @returns {{ start: () => void, stop: () => void, running: Ref<boolean> }}
 *
 * @example
 *   const { start, stop, running } = useRafLoop((dt, elapsed) => {
 *     el.style.transform = `translateX(${Math.sin(elapsed) * 100}px)`;
 *   });
 */
export function useRafLoop(callback, { autoStart = true } = {}) {
  let rafId = null;
  let last = 0;
  let elapsed = 0;
  const running = ref(false);

  const tick = (now) => {
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    elapsed += dt;
    callback(dt, elapsed);
    rafId = requestAnimationFrame(tick);
  };

  const start = () => {
    if (running.value) return;
    running.value = true;
    last = 0;
    elapsed = 0;
    rafId = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (!running.value) return;
    running.value = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  };

  onMounted(() => {
    if (autoStart) start();
  });

  onBeforeUnmount(() => {
    stop();
  });

  return { start, stop, running };
}
