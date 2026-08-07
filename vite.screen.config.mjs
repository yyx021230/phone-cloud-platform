import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: "screen-client/main.js",
      formats: ["es"],
      fileName: () => "screen-control.js"
    },
    outDir: "public/vendor",
    assetsDir: ".",
    rollupOptions: {
      output: {
        assetFileNames: "screen-[name]-[hash][extname]"
      }
    }
  }
});
