// Глобальный middleware: нормализует URL.
// 1. Схлопывает повторяющиеся слеши: /foo//bar → /foo/bar
// 2. Добавляет trailing slash: /foo → /foo/
//
// Если URL уже нормальный — пропускаем без редиректа (важно, иначе будет цикл).

export default defineNuxtRouteMiddleware((to) => {
  const collapsed = to.path.replace(/\/{2,}/g, '/');
  const normalized = collapsed.endsWith('/') ? collapsed : `${collapsed}/`;

  if (normalized === to.path) return;

  return navigateTo({ path: normalized, query: to.query, hash: to.hash }, { redirectCode: 301 });
});
