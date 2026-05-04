<!--
  Полноэкранная страница эффекта. Никакого header/footer/панелей — только canvas и кнопка возврата.
  Slug → манифест → ленивый импорт компонента эффекта. Three.js клиентский, обёртка ClientOnly.
-->
<template>
  <div class="effect-stage">
    <ClientOnly>
      <component :is="EffectComponent" :key="effectKey" />
      <template #fallback>
        <div class="effect-stage__fallback">Загрузка эффекта…</div>
      </template>
    </ClientOnly>
    <NuxtLink to="/" class="effect-stage__back">← К каталогу</NuxtLink>
  </div>
</template>

<script setup>
  // Полный экран без шапки/подвала.
  definePageMeta({ layout: false });

  const route = useRoute();
  const slug = route.params.slug;
  const effect = getEffectBySlug(slug);

  if (!effect) {
    throw createError({ statusCode: 404, statusMessage: `Эффект "${slug}" не найден в манифесте` });
  }
  if (effect.status !== 'ready') {
    throw createError({ statusCode: 404, statusMessage: `Эффект "${slug}" пока не реализован (status=${effect.status})` });
  }

  // effect.component — () => import(...). defineAsyncComponent делает ленивый чанк на эффект.
  const EffectComponent = defineAsyncComponent(effect.component);

  // Перезапуск эффекта без перезагрузки страницы: смена :key пересоздаёт компонент,
  // что триггерит unmount (диспоуз three-ресурсов) → fresh mount.
  const effectKey = ref(0);
  if (import.meta.client) {
    const onRestart = () => effectKey.value++;
    window.addEventListener('effect-restart', onRestart);
    onBeforeUnmount(() => window.removeEventListener('effect-restart', onRestart));
  }

  usePageSeo({
    defaultTitle: `${effect.title} — AI Animation`,
    defaultDescription: effect.description,
  });
</script>

<style lang="scss" scoped>
  .effect-stage {
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: #ffffff;

    &__fallback {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 14px;
    }

    &__back {
      position: absolute;
      top: 16px;
      left: 16px;
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      text-decoration: none;
      border-radius: 6px;
      font-size: 13px;
      backdrop-filter: blur(10px);
      z-index: 10;
      transition: background 0.15s;

      &:hover {
        background: rgba(0, 0, 0, 0.75);
      }
    }
  }
</style>
