/// <reference types="vite/client" />
//
// Ambient types for the vite app: `import.meta.env` (read by the harness API
// client's root-resolution chain) and the CSS-module/global-stylesheet forms the
// dashboard imports. Needed the moment `src/main.tsx` imports a `.css` file,
// because this package's tsconfig has no `vite/client` reference of its own.

declare const __APP_VERSION__: string;
