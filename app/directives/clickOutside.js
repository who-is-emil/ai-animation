/**
 * v-click-outside — вызывает обработчик при клике вне элемента.
 *
 * Использование:
 *   <div v-click-outside="onOutsideClick">...</div>
 *
 * Регистрируется в app/plugins/directives.client.js
 */
export const clickOutside = {
  beforeMount(el, binding) {
    el.__clickOutside = (event) => {
      if (el !== event.target && !el.contains(event.target)) {
        binding.value(event);
      }
    };
    // capture: true — чтобы перехватить раньше, чем сработают stopPropagation внутри
    document.addEventListener('click', el.__clickOutside, true);
  },

  unmounted(el) {
    document.removeEventListener('click', el.__clickOutside, true);
    delete el.__clickOutside;
  },
};
