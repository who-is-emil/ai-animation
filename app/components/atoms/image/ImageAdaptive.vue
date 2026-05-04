<template>
  <div class="image" itemscope itemtype="http://schema.org/ImageObject">
    <picture v-if="disableLazy">
      <source v-if="mob" :media="`(max-width: ${devicesValue.md - 1}px)`" :srcset="computedSrcset(mob.srcset)" />
      <source v-if="tab" :media="`(max-width: ${devicesValue.lg - 1}px)`" :srcset="computedSrcset(tab.srcset)" />
      <img :src="src" :alt="alt" :srcset="computedSrcset(srcset)" />
    </picture>

    <picture v-else>
      <source v-if="mob" :media="`(max-width: ${devicesValue.md - 1}px)`" :srcset="computedSrcset(mob.srcset)" />
      <source v-if="tab" :media="`(max-width: ${devicesValue.lg - 1}px)`" :srcset="computedSrcset(tab.srcset)" />
      <img :src="srcRaw" :alt="alt" :srcset="computedSrcset(srcset)" loading="lazy" />
    </picture>

    <span v-if="description" :itemprop="description">{{ description }}</span>
  </div>
</template>

<script setup>
  import { devices } from '~/composables/useBreakpoints';

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
    description: String,
  });

  const devicesValue = ref(devices);

  const srcRaw = computed(() => {
    if (props.src) return props.src.replace(/\s/g, '%20');

    return null;
  });

  function computedSrcset(srcSet) {
    if (!srcSet) return null;
    // srcSet: [{src, scale}, ...] → "img1.jpg 1x, img2.jpg 2x"
    return srcSet.map((item) => `${item.src.replace(/\s/g, '%20')} ${item.scale}x`).join(', ');
  }
</script>
