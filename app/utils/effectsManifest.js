// Манифест всех эффектов проекта. Единый источник правды для:
// • разводящей страницы (карточки на /)
// • динамического роута /effects/[slug]
// • поиска бриф-файла в /briefs/<slug>.md
//
// Чтобы добавить новый эффект:
//   1. Заполнить бриф в /briefs/<slug>.md (см. /briefs/_TEMPLATE.md)
//   2. Создать компонент app/components/effects/<PascalName>.vue, использующий useThreeScene
//   3. Добавить запись в массив EFFECTS ниже
//
// Поля:
//   slug         — kebab-case, должен совпадать с именем .md в /briefs/
//   title        — отображается на карточке и в <h1> страницы
//   description  — короткий тизер для карточки (1-2 строки)
//   component    — функция динамического импорта SFC: () => import('~/components/effects/<File>.vue').
//                  Используется через defineAsyncComponent на странице эффекта → каждый эффект
//                  попадает в свой lazy-чанк, не раздувая bundle главной.
//                  Не строка-имя: автоимпорт Nuxt работает только для статических тегов в шаблонах,
//                  через <component :is="строка"> компоненты не резолвятся.
//   tags         — массив строк (для будущей фильтрации); опционально
//   status       — 'ready' | 'planned' | 'wip'. 'planned' рендерит карточку без ссылки.

export const EFFECTS = [
  {
    slug: 'perspective-cylinder',
    title: 'Цилиндр в перспективе',
    description: 'Проволочный цилиндр, уходящий в даль. Прототип без брифа.',
    component: () => import('~/components/effects/PerspectiveCylinder.vue'),
    tags: ['wireframe', 'perspective'],
    status: 'ready',
  },
  {
    slug: 'cross',
    title: 'Магнитные кресты',
    description:
      '16 трёхцветных крестов толкутся вокруг малой невидимой сферы притяжения. Резкий флик курсора уносит крест за границу блока, силы тянут обратно.',
    component: () => import('~/components/effects/Cross.vue'),
    tags: ['mesh', 'physics', 'magnetism', 'pbr'],
    status: 'ready',
  },
  {
    slug: 'confetti-pool',
    title: 'Бассейн с конфетти',
    description:
      'Цветные фигуры ведут себя как жидкость: льются из центра, заполняют объём, реагируют на курсор как на препятствие. FLIP/PIC, точное воспроизведение референса.',
    component: () => import('~/components/effects/ConfettiPool.vue'),
    tags: ['particles', 'physics', '2d', 'liquid', 'flip'],
    status: 'ready',
  },
  {
    slug: 'about-hero-vortex',
    title: 'Вихрь сфер',
    description:
      'Облако маленьких сфер закручено вокруг светящейся точки. Половина потока вращается в одну сторону, половина — в обратную; curl-noise добавляет витания.',
    component: () => import('~/components/effects/AboutHeroVortex.vue'),
    tags: ['particles', 'gpgpu', 'curl-noise', 'instancing'],
    status: 'ready',
  },
  {
    slug: 'silk',
    title: 'Шёлк',
    description:
      'Тонкое тёмно-золотое полотно, прибитое за край. Мягкий ветер без гравитации развевает ткань, поверх перетекают невысокие холмики. Сбоку — линия в 1px.',
    component: () => import('~/components/effects/Silk.vue'),
    tags: ['shader', 'mesh', 'simplex-noise', 'orbit'],
    status: 'ready',
  },
  {
    slug: 'triangular-prism',
    title: 'Треугольная призма',
    description:
      'Вытянутая полая призма из анодированного алюминия. Стоит вертикально, видна верхушка с треугольным срезом-кольцом — читается полость. Статичный 3D-натюрморт с двусторонним верхне-боковым светом.',
    component: () => import('~/components/effects/TriangularPrism.vue'),
    tags: ['mesh', 'pbr', 'extrude', 'static'],
    status: 'ready',
  },
];

/** Найти эффект по slug. */
export function getEffectBySlug(slug) {
  return EFFECTS.find((e) => e.slug === slug) || null;
}
