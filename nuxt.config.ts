// https://nuxt.com/docs/api/configuration/nuxt-config
import svgLoader from 'vite-svg-loader';
import glsl from 'vite-plugin-glsl';

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',

  devtools: { enabled: true },

  // Базовый <head> для всех страниц. Расширяй на конкретных страницах через useHead/usePageSeo
  app: {
    head: {
      // class="no-js" нужен для скролл-анимаций (см. base/animation.scss).
      // Inline-скрипт ниже синхронно меняет no-js → js до парсинга body, поэтому FOUC нет.
      htmlAttrs: { lang: 'ru', class: 'no-js' },
      script: [
        {
          tagPosition: 'head',
          innerHTML: "document.documentElement.classList.replace('no-js','js')",
        },
      ],
      link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    },
  },

  // Публичные переменные доступны и на сервере, и на клиенте через useRuntimeConfig().public
  // Приватные (без public) — только на сервере
  // Имена в camelCase. Nuxt автоматически мапит их на NUXT_* env-переменные:
  // public.apiUrl ←→ NUXT_PUBLIC_API_URL
  runtimeConfig: {
    public: {
      apiUrl: '',
      baseUrl: '',
    },
  },

  modules: ['@pinia/nuxt', '@nuxt/eslint', '@nuxt/fonts', '@nuxtjs/sitemap', '@nuxtjs/robots'],

  css: ['~/assets/scss/main.scss'],

  vue: {
    compilerOptions: {
      // Разрешаем кастомные элементы, например <swiper-container>
      isCustomElement: (tag) => tag.startsWith('swiper-'),
    },
  },

  vite: {
    plugins: [
      // Импорт SVG как Vue-компонентов: import IconArrow from '~/assets/icons/24/arrow.svg?component'
      svgLoader({
        defaultImport: 'component',
        svgo: false,
      }),
      // Импорт GLSL-шейдеров строкой: import frag from '~/effects/foo/shader.frag'
      // Поддерживает #include, минификацию и source maps в dev
      glsl({
        compress: false,
      }),
    ],
    css: {
      preprocessorOptions: {
        scss: {
          // Глобально подключаем переменные/миксины, чтобы использовать их в любом SFC без явного @use
          additionalData: '@use "~/assets/scss/abstracts" as *;',
        },
      },
    },
    build: {
      // Vite по умолчанию делит CSS на чанки и грузит их через <link rel="stylesheet">,
      // ожидая событий load/error, которые в проде иногда не срабатывают и навигация подвисает.
      // Бандлим весь CSS в один файл — динамическая загрузка CSS отключается.
      cssCodeSplit: false,
    },
  },

  nitro: {
    output: { dir: 'dist' },
    routeRules: {
      // Долгий кеш для иммутабельных ассетов
      '/_nuxt/**': { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
      '/fonts/**': { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
    },
  },

  sitemap: {
    // Site URL обязателен для @nuxtjs/sitemap. Берётся из env NUXT_PUBLIC_BASE_URL
    autoLastmod: true,
    cacheMaxAgeSeconds: 3600,
    xsl: false,
  },

  robots: {
    // По дефолту закрываем «мусорные» урлы и параметры. Подстраивай под проект.
    // Для granular-правил по user-agent используй groups: [{ userAgents, allow, disallow }]
    disallow: ['/*.pdf', '/*.xls', '/*.doc', '/*?*'],
    allow: ['/*.js', '/*.css', '/*.jpg', '/*.jpeg', '/*.png', '/*.gif', '/*.webp', '/*.svg'],
  },

  fonts: {
    // По умолчанию модуль ищет шрифты в public/fonts и assets/fonts.
    // Если шрифт есть в Google/Bunny — скачает его в сборку и добавит preload автоматически.
    // Подробнее: https://fonts.nuxt.com
  },

  eslint: {
    config: {
      stylistic: false,
    },
  },
});
