// Keep this Vite macro unconditional: conditional import.meta.glob is not
// transformed into the eager raw module table.
export const builtinCardSourceFiles = import.meta.glob([
  '/src/cards/**/*.{ts,tsx,mjs,css}', '/src/parts/**/*.{ts,tsx,mjs,css}',
  '/src/render/**/*.{ts,tsx,mjs,css}', '/src/kernel/**/*.{ts,tsx,mjs,css}',
  '!/src/**/*.test.{ts,tsx,mjs,js}',
], { query: '?raw', import: 'default', eager: true });
