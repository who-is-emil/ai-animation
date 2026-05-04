export const disableScroll = () => {
  const { body } = document;
  const scrollY = window.pageYOffset;

  document.documentElement.dataset.scrollY = scrollY;
  body.classList.add('js-locked');
  document.documentElement.classList.add('is-locked');
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.width = '100%';
};

export const enableScroll = () => {
  const { body } = document;
  const scrollY = parseInt(document.documentElement.dataset.scrollY || '0', 10);

  delete document.documentElement.dataset.scrollY;

  body.style.position = '';
  body.style.top = '';
  body.style.width = '';

  // Safari отрисовывает промежуточное состояние между снятием position:fixed и вызовом scrollTo,
  // что вызывает видимый прыжок страницы наверх. Отключение scroll-behavior гарантирует мгновенное восстановление.
  const prevScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';

  window.scrollTo(0, scrollY);

  document.documentElement.style.scrollBehavior = prevScrollBehavior;

  setTimeout(() => {
    document.documentElement.classList.remove('is-locked');
    body.classList.remove('js-locked');
  }, 1);
};
