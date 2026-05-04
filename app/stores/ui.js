// Пример Pinia-стора. Удали или используй как образец.
//
// Сторы в app/stores/ автоматически доступны без явного импорта.
// Использование в компоненте:
//   const ui = useUiStore();
//   ui.openMenu();
//
// Подробнее: https://pinia.vuejs.org/

export const useUiStore = defineStore('ui', () => {
  const isMenuOpen = ref(false);
  const isModalOpen = ref(false);

  const openMenu = () => {
    isMenuOpen.value = true;
  };

  const closeMenu = () => {
    isMenuOpen.value = false;
  };

  const toggleMenu = () => {
    isMenuOpen.value = !isMenuOpen.value;
  };

  return {
    isMenuOpen,
    isModalOpen,
    openMenu,
    closeMenu,
    toggleMenu,
  };
});
