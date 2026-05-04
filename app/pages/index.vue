<!--
  Разводящая страница: галерея всех эффектов из манифеста.
  Карточка ведёт на /effects/<slug>. Эффекты со status: 'planned' рендерятся без ссылки.
-->
<template>
  <div class="effects-gallery">
    <header class="effects-gallery__head">
      <h1 class="effects-gallery__title">AI Animation — каталог эффектов</h1>
      <p class="effects-gallery__sub">
        Каждая карточка — отдельный эффект. Брифы лежат в <code>/briefs/</code>, реализации — в <code>app/components/effects/</code>.
      </p>
    </header>

    <ul class="effects-gallery__list">
      <li v-for="e in EFFECTS" :key="e.slug" class="effects-gallery__item">
        <component
          :is="e.status === 'ready' ? NuxtLink : 'div'"
          v-bind="e.status === 'ready' ? { to: `/effects/${e.slug}` } : {}"
          class="effects-card"
          :class="{ 'effects-card--planned': e.status !== 'ready' }"
        >
          <div class="effects-card__preview">
            <span class="effects-card__status">{{ statusLabel(e.status) }}</span>
          </div>
          <div class="effects-card__body">
            <h2 class="effects-card__title">{{ e.title }}</h2>
            <p class="effects-card__desc">{{ e.description }}</p>
            <div class="effects-card__meta">
              <code class="effects-card__slug">{{ e.slug }}</code>
              <span v-for="t in e.tags" :key="t" class="effects-card__tag">{{ t }}</span>
            </div>
          </div>
        </component>
      </li>
    </ul>
  </div>
</template>

<script setup>
  import { NuxtLink } from '#components';

  // EFFECTS — auto-import из app/utils/effectsManifest.js

  usePageSeo({
    defaultTitle: 'AI Animation — каталог эффектов',
    defaultDescription: 'Бойлерплейт-генератор three.js эффектов на Nuxt 4',
  });

  function statusLabel(s) {
    if (s === 'ready') return 'готов';
    if (s === 'wip') return 'в работе';
    return 'запланирован';
  }
</script>

<style lang="scss" scoped>
  .effects-gallery {
    @include container;
    padding-top: 64px;
    padding-bottom: 96px;

    &__head {
      max-width: 760px;
      margin-bottom: 48px;
    }

    &__title {
      font-size: clamp(28px, 4vw, 48px);
      line-height: 1.1;
      letter-spacing: -0.02em;
      margin: 0 0 16px;
    }

    &__sub {
      color: var(--text-muted);
      font-size: 16px;
      line-height: 1.5;
      margin: 0;

      code {
        background: rgba(0, 0, 0, 0.06);
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 0.9em;
      }
    }

    &__list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 24px;
    }

    &__item {
      display: contents;
    }
  }

  .effects-card {
    display: flex;
    flex-direction: column;
    background: var(--white-1);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    text-decoration: none;
    color: inherit;
    transition:
      transform 0.2s ease,
      box-shadow 0.2s ease,
      border-color 0.2s ease;

    &:hover:not(&--planned) {
      transform: translateY(-2px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.08);
      border-color: var(--accent);
    }

    &--planned {
      opacity: 0.55;
      cursor: not-allowed;
    }

    &__preview {
      position: relative;
      aspect-ratio: 16 / 10;
      background: linear-gradient(135deg, #1a1a22, #2a2a36);
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      padding: 12px;
    }

    &__status {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
    }

    &__body {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex: 1;
    }

    &__title {
      font-size: 18px;
      line-height: 1.3;
      margin: 0;
      font-weight: 600;
    }

    &__desc {
      font-size: 14px;
      line-height: 1.5;
      color: var(--text-muted);
      margin: 0;
    }

    &__meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: auto;
    }

    &__slug {
      font-size: 12px;
      color: var(--text-muted);
      background: rgba(0, 0, 0, 0.04);
      padding: 2px 6px;
      border-radius: 4px;
    }

    &__tag {
      font-size: 11px;
      color: var(--accent);
      background: var(--accent-1-20);
      padding: 2px 6px;
      border-radius: 4px;
    }
  }
</style>
