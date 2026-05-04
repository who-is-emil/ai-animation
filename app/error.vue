<!--
  Глобальная страница ошибок Nuxt. Рендерится при необработанной ошибке на сервере или клиенте.
  Подробнее: https://nuxt.com/docs/getting-started/error-handling
-->
<template>
  <NuxtLayout name="error">
    <div class="error-page">
      <div class="error-page__code">{{ error.statusCode }}</div>
      <div class="error-page__message">{{ message }}</div>
      <button class="error-page__button" type="button" @click="handleError">На главную</button>
    </div>
  </NuxtLayout>
</template>

<script setup>
  const props = defineProps({
    error: {
      type: Object,
      required: true,
    },
  });

  // Понятные сообщения для самых частых статусов
  const messages = {
    404: 'Страница не найдена',
    500: 'Внутренняя ошибка сервера',
    403: 'Доступ запрещён',
  };

  const message = computed(() => messages[props.error.statusCode] || props.error.message || 'Что-то пошло не так');

  // clearError сбрасывает состояние ошибки и редиректит на указанный путь
  const handleError = () => clearError({ redirect: '/' });
</script>
