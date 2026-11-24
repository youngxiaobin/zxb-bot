import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "electron-main" || mode === "electron-preload") {
    const entry = mode === "electron-main" ? "main" : "preload";
    return {
      build: {
        target: "node20",
        outDir: `dist/electron/${entry}`,
        emptyOutDir: true,
        lib: {
          entry: `src/main/${entry}.ts`,
          formats: ["cjs"],
          fileName: () => `${entry}.cjs`,
        },
        rollupOptions: {
          external: (id) =>
            id === "electron" ||
            (entry === "main" && (id === "ws" || id.startsWith("node:"))),
        },
      },
    };
  }

  return {
    root: ".",
    base: "./",
    plugins: [react()],
    server: { host: "127.0.0.1", port: 47331, strictPort: true },
    build: { outDir: "dist/renderer", emptyOutDir: true },
    resolve: { preserveSymlinks: true },
  };
});
