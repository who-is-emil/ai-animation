const modules = import.meta.glob('./**/*.svg', { eager: true });

export const icons = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => {
    const name = path.replace('./', '').replace('.svg', '');

    return [name, mod.default];
  })
);
