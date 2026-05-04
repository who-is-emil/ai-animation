/**
 * SSR-safe одиночный POST/GET запрос с реактивным body.
 * Меняешь params.value — useAsyncData автоматически перезапрашивает данные.
 *
 * Использование:
 *   const { data, status, error, refresh, params } = useFetchData({
 *     url: '/catalog/list',
 *     body: { page: 1, limit: 20 },
 *   }, 'catalog');
 *
 *   // позже:
 *   params.value.page = 2;  // refetch произойдёт автоматически
 *
 * @param {{url: string, body?: object, method?: string, options?: object}} config
 * @param {string} asyncKey — уникальный ключ для useAsyncData.
 */
export const useFetchData = ({ url, body = {}, method = 'POST', options = {} }, asyncKey = 'fetch-data') => {
  const params = ref({ ...body });

  const { data, status, error, refresh } = useAsyncData(
    asyncKey,
    async () => {
      const fetchFn = import.meta.server ? useRequestFetch() : $fetch;

      return await fetchFn(url, {
        method,
        body: params.value,
        credentials: 'include',
        ...options,
      });
    },
    {
      // Перезапуск при изменении params (deep watch включён по умолчанию для ref'ов)
      watch: [params],
      server: true,
      lazy: false,
      dedupe: 'defer',
    }
  );

  return { data, status, error, refresh, params };
};
