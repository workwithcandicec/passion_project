import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: `base` must match your GitHub repo name exactly,
// because GitHub Pages serves project sites from /<repo-name>/.
export default defineConfig({
  plugins: [react()],
  base: "/passion-project-planner/",
});
