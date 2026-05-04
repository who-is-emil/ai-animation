/**
 * Анимации появления при скролле через IntersectionObserver.
 *
 * Использование в шаблоне:
 *   <div data-animate="fade-in-up">...</div>
 *   <div data-animate="fade" style="--animate-delay: 0.3s">...</div>
 *
 * Доступные значения data-animate определяются CSS в assets/scss/base/animation.scss
 * (по умолчанию: 'fade', 'fade-in-up'). Чтобы добавить новый — допиши CSS-блок там.
 *
 * Задержка: атрибут style="--animate-delay: 0.5s" — гибче, чем attribute-selector.
 *
 * Custom events:
 *   document.dispatchEvent(new CustomEvent('animate:refresh'))
 *     — пересканировать DOM (после Vue-навигации, добавления контента)
 *   document.dispatchEvent(new CustomEvent('animate:run', { detail: { root: someEl } }))
 *     — принудительно проиграть анимации в подэлементе, минуя observer
 *
 * FOUC: класс html.js ставится синхронно inline-скриптом из nuxt.config.ts → app.head.script,
 * до парсинга body. Поэтому элементы не мигают между серверным рендером и инициализацией плагина.
 */
export default defineNuxtPlugin(() => {
  const getElements = (root = document) => Array.from(root.querySelectorAll('[data-animate]'));

  const runAnimation = (el) => {
    if (el.__animated) return;
    el.__animated = true;
    el.classList.add('animate');
    if (el.__observer) {
      el.__observer.unobserve(el);
      el.__observer = null;
    }
  };

  const onIntersect = (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) runAnimation(entry.target);
    });
  };

  const observe = (root = document) => {
    getElements(root).forEach((el) => {
      // Большие элементы — низкий threshold, мелкие — выше: иначе крупный блок
      // никогда полностью не попадёт в viewport и анимация не запустится
      const threshold = el.offsetHeight > 500 ? 0.05 : 0.2;

      el.__observer = new IntersectionObserver(onIntersect, { threshold });
      el.__observer.observe(el);
    });
  };

  const reset = () => {
    getElements().forEach((el) => {
      el.classList.remove('animate');
      el.__animated = false;
      if (el.__observer) {
        el.__observer.disconnect();
        el.__observer = null;
      }
    });
  };

  const refresh = () => {
    reset();
    observe();
  };

  const runManual = (root) => {
    getElements(root || document).forEach(runAnimation);
  };

  // Старт
  observe();

  // События
  document.addEventListener('animate:refresh', refresh);
  document.addEventListener('animate:run', (e) => runManual(e.detail?.root));

  return {
    provide: {
      animateRefresh: refresh,
      animateRun: runManual,
    },
  };
});
