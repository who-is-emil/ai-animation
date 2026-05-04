<template>
  <div class="image" itemscope itemtype="http://schema.org/ImageObject">
    <img v-if="disableLazy" :src="srcRaw" :srcset="srcSetRaw" :alt="alt" />
    <img v-else-if="!disableLazy" :src="srcRaw" :srcset="srcSetRaw" :alt="alt" loading="lazy" />
    <span v-if="description" :itemprop="description">{{ description }}</span>
  </div>
</template>

<script setup>
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
    disableLazy: {
      type: Boolean,
    },
    description: String,
  });

  const srcRaw = computed(() => {
    if (props.src) return props.src.replace(/\s/g, '%20');

    return null;
  });

  const srcSetRaw = computed(() => {
    if (props.srcset) {
      const temp = props.srcset.split(', ');

      return temp.map((src) => {
        const tempSrc = src.split(' ');
        const condition = tempSrc.splice(-1);
        return `${tempSrc.join('%20')} ${condition}`;
      });
    }

    return null;
  });
</script>
