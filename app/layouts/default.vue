<template>
  <div class="default-layout">
    <div class="default-layout__header">
      <Header />
    </div>

    <div class="default-layout__menu" />

    <slot />

    <div class="default-layout__footer">
      <Footer />
    </div>
  </div>
</template>

<script setup>
  // Auto-import именует компоненты по полному пути (OrganismsHeader),
  // явный импорт даёт более чистое имя в шаблоне.
  import Header from '~/components/organisms/header/Header.vue';
  import Footer from '~/components/organisms/footer/Footer.vue';
</script>
