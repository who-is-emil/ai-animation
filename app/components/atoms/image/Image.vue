<template>
  <ImageAdaptive v-if="$props.tab || $props.mob" v-bind="props" />
  <ImageRegular v-else v-bind="props" />
</template>

<script setup>
  import ImageAdaptive from './ImageAdaptive.vue';
  import ImageRegular from './ImageRegular.vue';

  const props = defineProps({
    src: {
      type: String,
    },
    srcset: {
      type: String,
    },
    alt: {
      type: String,
      default: '',
    },
    mob: {
      type: Object,
    },
    tab: {
      type: Object,
    },
    disableLazy: {
      type: Boolean,
    },
  });
</script>

<style lang="scss" scoped>
  @use './Image.scss';
</style>
