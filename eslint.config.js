// https://eslint.nuxt.com/packages/module
// @nuxt/eslint модуль автогенерит базовый flat-конфиг с автоимпортами Nuxt,
// плагином vue, правилами под Nuxt 4. Здесь мы только дополняем его своими правилами.
import withNuxt from './.nuxt/eslint.config.mjs';
import prettier from '@vue/eslint-config-prettier';

export default withNuxt(
  // Базовый prettier-конфиг отключает все ESLint-правила, конфликтующие с Prettier
  prettier,
  {
    // Reference-файлы в корне (example.vue, useScene.js, useRafLoop.js) — образцы,
    // не часть сборки. Дубликаты композаблов лежат в app/composables/.
    ignores: ['example.vue', 'useScene.js', 'useRafLoop.js'],
  },
  {
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      'vue/max-attributes-per-line': 'off',
    },
  }
);
