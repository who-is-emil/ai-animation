// Регистрация кастомных директив. Только client — директивы используют document.
//
// Чтобы добавить новую директиву:
// 1. Создай файл в app/directives/ (например, intersect.js) с export const intersect = {...}
// 2. Импортируй сюда и зарегистрируй nuxtApp.vueApp.directive('имя-в-шаблоне', importedDirective)
// 3. Используй в шаблоне: v-имя-в-шаблоне
import { clickOutside } from '~/directives/clickOutside';

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('click-outside', clickOutside);
});
