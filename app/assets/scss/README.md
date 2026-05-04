# SCSS-структура

## Что где лежит

```
scss/
├── abstracts.scss    ← @forward всех vars и mixins. Глобально инжектится в каждый <style lang="scss">
│                       и SCSS-файл через nuxt.config.ts → vite.css.preprocessorOptions.scss.additionalData
├── main.scss         ← entry-point для глобальных стилей. Подключается в nuxt.config.ts → css
│
├── vars/             ← Sass-переменные (нужны там, где CSS-vars не работают: @media, calc, map'ы)
│   ├── grid.scss          ← $grid-breakpoints, $grid-max-width
│   ├── spacing.scss       ← $spacers (для генерации utility-классов)
│   ├── animations.scss    ← $timing, $easing
│   └── icons.scss         ← inline data-URI иконки
│
├── mixins/           ← Sass-функции и миксины (без CSS-вывода)
│   ├── rem.scss           ← rem(), rem-map()
│   ├── breakpoints.scss   ← media-breakpoint-up/down/only/between
│   ├── typography.scss    ← typography($type) — применяет CSS-переменные шрифта
│   ├── container.scss     ← container() — горизонтальные отступы контейнера
│   └── helpers.scss       ← hover, line-clamp, visually-hidden и др.
│
├── tokens/           ← CSS-переменные (динамические, могут меняться рантайм-темами)
│   ├── primitives.scss    ← палитра «кирпичей»: --black-1, --grey-1, --accent-1...
│   ├── base.scss          ← семантические алиасы: --bg, --text, --border, --accent
│   ├── typography.scss    ← --font-size-*, --line-height-*, --font-weight-*
│   ├── shadow.scss        ← --shadow-*
│   └── container.scss     ← --container-left, --container-right
│
├── base/             ← Глобальные стили (выводят CSS, подключаются один раз через main.scss)
│   ├── reboot.scss        ← reset
│   ├── scale-html.scss    ← пиксель-перфектное масштабирование font-size html
│   ├── typography.scss    ← h1-h3, .text-body
│   ├── container.scss     ← .container
│   ├── user-text.scss     ← стили для контента из CMS (.user-text)
│   ├── main.scss          ← body { background, color }
│   └── animation.scss     ← Vue-transitions, scroll-анимации
│
├── utils/            ← Утилитарные классы
│   ├── display.scss       ← .visually-hidden, .z-1, .z-2
│   └── spacing.scss       ← авто-генерируемые .mt-*, .pb-md-* и т.д.
│
└── layouts/          ← Стили лейаутов (.default-layout, .error-layout)
    ├── default-layout.scss
    └── error-layout.scss
```

## Работа с токенами

Бойлерплейт намеренно содержит **минимум токенов** — только то, что нужно для работы базовой типографики и фонов. Расширяй под проект, но без фанатизма.

### Два слоя

```
primitives.scss   →   base.scss          →   компоненты
(--black-1)           (--text: var(...))      color: var(--text)
```

- **primitives** — палитра без смысла. Цвета, оттенки. Имя описывает ЦВЕТ.
- **base** — семантические алиасы. Имя описывает НАЗНАЧЕНИЕ. Ссылается на primitives.
- В компонентах используй **семантические** (`var(--text)`), а не примитивы (`var(--black-1)`).
  Тогда смена темы или ребрендинг — это правка одного файла, а не всего проекта.

### Когда добавлять токен

**Только если значение используется минимум в двух местах.**

Если у одной кнопки `padding: 12px 24px` — пиши литералом. Если такой же padding у трёх компонентов — заводи переменную или миксин.

### Что НЕ делать

- Не плодить «компонентные» токены (`--button-bg`, `--card-padding`). Стили компонента живут в его файле и используют примитивы/семантику напрямую.
- Не дублировать примитивы в base без причины (`--text-grey: var(--grey-2)` — плохо, лучше использовать `var(--grey-2)` напрямую, либо назвать `--text-muted` если есть смысл).
- Не объявлять токен «на будущее». Удалить мёртвый код легче, чем понять зачем он был.

### Шаблон: добавить новый цвет

1. В `primitives.scss`:
   ```scss
   --blue-1: #2b6cb0;
   ```
2. Если он используется как «цвет ссылки» — в `base.scss`:
   ```scss
   --link: var(--blue-1);
   ```
3. В компоненте: `color: var(--link);`

### Шаблон: добавить новый тип типографики

Имена обязаны соответствовать шаблону, иначе миксин `typography($type)` не найдёт переменные.

1. В `tokens/typography.scss` объяви все 5 переменных для типа `lead`:
   ```scss
   --font-size-lead-xl: #{rem(24)};
   --font-size-lead-lg: #{rem(20)};
   --font-size-lead-sm: #{rem(18)};
   --line-height-lead-xl: 1.3;
   --line-height-lead-lg: 1.3;
   --line-height-lead-sm: 1.3;
   --letter-spacing-lead-xl: 0;
   --letter-spacing-lead-lg: 0;
   --letter-spacing-lead-sm: 0;
   --font-weight-lead: var(--font-weight-medium);
   --text-transform-lead: none;
   ```
2. Используй: `@include typography(lead);`

## Sass vs CSS-переменные

| Что хочу                                                        | Что использовать           |
| --------------------------------------------------------------- | -------------------------- |
| Цвет, тень, размер шрифта (нужна реактивность для тем)          | CSS-переменная в `tokens/` |
| Брейкпоинт, спейсинг для `@media`, базовое значение для `rem()` | Sass-переменная в `vars/`  |

**Простое правило:** если значение нужно внутри `@media`, `calc`, `map.get` — Sass-переменная. Иначе — CSS-переменная.

## Использование переменных и миксинов

В любом SFC они доступны без явного импорта (через `additionalData`):

```vue
<style lang="scss" scoped>
  .card {
    padding: rem(24);
    color: var(--text);

    @include media-breakpoint-up(md) {
      padding: rem(40);
    }

    @include hover {
      color: var(--accent);
    }
  }
</style>
```

В любом `.scss`-файле, подключаемом через `@use` (partial в `app/assets/scss/`, компонентный `ComponentName.scss` и т.д.), **нужен явный** импорт abstracts:

```scss
@use '../../../assets/scss/abstracts' as *; // путь относительный от файла

.foo { ... }
```

`additionalData` с алиасом `~/` не резолвится в контексте вложенных модулей — только в SFC `<style>` и top-level entries (`main.scss`).

## Именование

- Sass-переменные: `$kebab-case` — `$grid-breakpoints`, `$base-value`
- CSS-переменные: `--kebab-case` — `--font-size-h1-xl`, `--container-left-sm`
- Миксины и функции: `kebab-case` — `media-breakpoint-up`, `default-transition`

## Что НЕ делать (синтаксис)

- Не используй `@import` — deprecated в Sass. Только `@use`/`@forward`.
- Не используй `if(condition, a, b)` — deprecated. Только `@if/@else`.
- Не используй `/` для деления чисел — только `math.div($a, $b)` (требует `@use 'sass:math'`).
- Не используй `silenceDeprecations` в конфиге — это симптом, а не лечение.

## Как добавить файл в сборку

| Файл                            | Куда положить                 | Что прописать                                                                       |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| Глобальный CSS (reset, утилита) | `base/`, `utils/`, `layouts/` | `@forward 'имя'` в одноимённом `index.scss`                                         |
| Новый миксин/функция            | `mixins/`                     | `@forward 'mixins/имя'` в `abstracts.scss` (тогда станет глобально доступным в SFC) |
| Новая Sass-переменная           | `vars/`                       | `@forward 'vars/имя'` в `abstracts.scss`                                            |
| Новый набор CSS-переменных      | `tokens/`                     | `@forward 'имя'` в `tokens/index.scss`                                              |
