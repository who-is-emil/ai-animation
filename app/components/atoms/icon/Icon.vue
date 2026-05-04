<template>
  <div class="icon">
    <component :is="SvgComponent" v-if="SvgComponent" />
  </div>
</template>

<script setup>
  import { icons } from '~/assets/icons/icons';

  const props = defineProps({
    name: {
      type: String,
      required: true,
    },
  });

  // shallowRef вместо ref — чтобы не делать deep-reactive из тяжёлого Vue-компонента
  const SvgComponent = shallowRef(null);

  watchEffect(() => {
    const found = icons[props.name];
    if (!found) {
      // eslint-disable-next-line no-console
      console.warn(`[Icon] Иконка не найдена: "${props.name}"`);
      SvgComponent.value = null;
      return;
    }
    SvgComponent.value = found;
  });
</script>

<style lang="scss" scoped>
  @use './Icon.scss';
</style>
