/**
 * Реактивные флаги текущего брейкпоинта (mobile / tablet / desktop).
 *
 * ВНИМАНИЕ: на SSR window недоступен — все рефы инициализируются как `false`.
 * Реальные значения проставляются на клиенте после монтирования. Если использовать
 * результат напрямую в шаблоне (`v-if="mob"`), будет hydration mismatch на первом рендере.
 * Для шаблонов оборачивай в <ClientOnly> или используй CSS-медиазапросы вместо JS.
 *
 * Для императивных проверок в обработчиках событий — безопасно.
 *
 * Брейкпоинты синхронизированы с $grid-breakpoints из assets/scss/vars/grid.scss.
 */

export const devices = {
  md: 640,
  lg: 1025,
};

export function useBreakpoints() {
  const desktop = ref(false);
  const tablet = ref(false);
  const mob = ref(false);

  const update = () => {
    desktop.value = window.matchMedia(`(min-width: ${devices.lg}px)`).matches;
    tablet.value = window.matchMedia(`(min-width: ${devices.md}px) and (max-width: ${devices.lg - 1}px)`).matches;
    mob.value = window.matchMedia(`(max-width: ${devices.md - 1}px)`).matches;
  };

  onMounted(() => {
    update();
    window.addEventListener('resize', update);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('resize', update);
  });

  return { desktop, tablet, mob };
}
