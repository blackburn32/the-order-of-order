import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "site-dist/", "node_modules/", "sim-out/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The landing page ships hand-written browser modules: no bundler, no
    // TypeScript pass, so its DOM globals have to be declared here.
    files: ["marketing-site/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        IntersectionObserver: "readonly",
        ResizeObserver: "readonly",
        cancelAnimationFrame: "readonly",
        clearInterval: "readonly",
        document: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        setInterval: "readonly",
        window: "readonly",
      },
    },
  },
);
