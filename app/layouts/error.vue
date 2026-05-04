<template>
  <div class="error-layout">
    <div class="error-layout__header">
      <Header />
    </div>

    <div class="error-layout__menu" />

    <div class="error-layout__main">
      <div class="error-layout__content">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup>
  import Header from '~/components/organisms/header/Header.vue';
</script>
