/**
 * SSR-safe параллельный fetch нескольких endpoints с агрегацией результатов.
 *
 * Использование:
 *   const { data } = await useGetData([
 *     { key: 'page', url: '/page/about' },
 *     { key: 'menu', url: '/menu/main' },
 *   ], 'about-page');
 *
 *   // data.value === { page: { data: ..., error: null }, menu: {...} }
 *
 * Если один из запросов падает — остальные всё равно отрабатывают (Promise.allSettled).
 *
 * @param {Array<{key: string, url: string, body?: any, method?: string, options?: object}>} requests
 * @param {string} asyncKey — уникальный ключ для useAsyncData (важно для кэша/гидрации).
 */
export const useGetData = (requests, asyncKey = 'get-data') => {
  return useAsyncData(
    asyncKey,
    async () => {
      // На сервере используем useRequestFetch — он автоматически прокидывает cookies и заголовки клиента.
      // На клиенте — обычный $fetch.
      const fetchFn = import.meta.server ? useRequestFetch() : $fetch;

      const results = await Promise.allSettled(
        requests.map(({ url, body, method = 'GET', options = {} }) =>
          fetchFn(url, {
            method,
            credentials: 'include',
            body,
            ...options,
          })
        )
      );

      return processResults(requests, results);
    },
    {
      server: true,
      lazy: false,
      dedupe: 'defer',
    }
  );
};

function processResults(requests, results) {
  return requests.reduce((acc, req, i) => {
    const res = results[i];

    if (res.status === 'fulfilled') {
      acc[req.key] = { data: res.value, error: null };
    } else {
      acc[req.key] = {
        data: null,
        error: {
          message: res.reason?.message || 'Ошибка запроса',
          stack: import.meta.dev ? res.reason?.stack : undefined,
        },
      };
    }

    return acc;
  }, {});
}
