/**
 * Установка SEO-метатегов на странице с учётом структуры данных Битрикса.
 *
 * Использование:
 *   const { data } = await useGetData([{ key: 'page', url: '/page/about' }], 'about');
 *   usePageSeo({
 *     pageData: computed(() => data.value?.page?.data),
 *     defaultTitle: 'О компании',
 *     defaultDescription: 'Описание по умолчанию',
 *   });
 *
 * Реактивно: при изменении pageData теги в <head> обновятся.
 *
 * @param {object} options
 * @param {import('vue').Ref|import('vue').ComputedRef} options.pageData — реф/computed с ответом от API
 * @param {string} [options.defaultTitle]
 * @param {string} [options.defaultDescription]
 * @param {string} [options.canonicalPath] — переопределить путь для canonical (по умолчанию route.path)
 * @param {string} [options.yandexVerification] — значение для <meta name="yandex-verification">
 * @param {string} [options.ogImage] — URL картинки для og:image
 */
export const usePageSeo = (options) => {
  const { pageData, defaultTitle = '', defaultDescription = '', canonicalPath, yandexVerification, ogImage } = options;

  const config = useRuntimeConfig();
  const route = useRoute();

  // Все вычисления через computed — иначе useHead зафиксирует значения один раз и потеряет реактивность
  const title = computed(() => pageData?.value?.PROPERTIES?.SEO_TITLE?.VALUE || pageData?.value?.NAME || defaultTitle);

  const description = computed(() => pageData?.value?.PROPERTIES?.SEO_DESCRIPTION?.VALUE || defaultDescription);

  const canonicalUrl = computed(() => {
    const base = (config.public.baseUrl || '').replace(/\/$/, '');
    const path = canonicalPath || route.path;

    return `${base}${path}`;
  });

  // useHead принимает функции-геттеры — это сохраняет реактивность
  useHead({
    title: () => title.value,
    meta: [
      { name: 'description', content: () => description.value },
      // OG
      { property: 'og:title', content: () => title.value },
      { property: 'og:description', content: () => description.value },
      { property: 'og:url', content: () => canonicalUrl.value },
      { property: 'og:type', content: 'website' },
      ...(ogImage ? [{ property: 'og:image', content: ogImage }] : []),
      // Twitter
      { name: 'twitter:card', content: ogImage ? 'summary_large_image' : 'summary' },
      { name: 'twitter:title', content: () => title.value },
      { name: 'twitter:description', content: () => description.value },
      // Yandex verification
      ...(yandexVerification ? [{ name: 'yandex-verification', content: yandexVerification }] : []),
    ],
    link: [{ rel: 'canonical', href: () => canonicalUrl.value }],
  });

  return { title, description, canonicalUrl };
};
