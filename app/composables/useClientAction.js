/**
 * Client-side helper для императивных запросов с loading/error состоянием.
 * Используй для отправки форм, лайков, удалений и т.п. — где запрос инициирует
 * пользователь, и нужно показать спиннер + обработать ошибку.
 *
 * Для получения данных страницы (SSR/SEO) используй useFetchData / useGetData.
 *
 * Использование:
 *   const { run, loading, error } = useClientAction();
 *
 *   const onSubmit = async () => {
 *     const res = await run('/form/submit', { method: 'POST', body: form.value });
 *     if (res) toast.success('Отправлено');
 *   };
 *
 * Защита от двойного клика встроена: пока loading=true, повторный вызов вернёт null.
 */
export const useClientAction = () => {
  const loading = ref(false);
  const error = ref(null);

  const run = async (url, options = {}) => {
    if (loading.value) return null;

    loading.value = true;
    error.value = null;

    try {
      return await $fetch(url, {
        credentials: 'include',
        ...options,
      });
    } catch (e) {
      error.value = e;
      return null;
    } finally {
      loading.value = false;
    }
  };

  return { run, loading, error };
};
