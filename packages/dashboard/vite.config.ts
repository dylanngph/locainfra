/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.LOCAINFRA_API ?? "http://127.0.0.1:4488";

export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: { "@": path.resolve(import.meta.dirname, "./src") },
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		proxy: {
			"/api": { target: API_TARGET, changeOrigin: false },
			"/ws": { target: API_TARGET.replace("http", "ws"), ws: true },
		},
	},
	build: { outDir: "dist", sourcemap: false },
	test: {
		environment: "happy-dom",
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		coverage: { provider: "v8", reporter: ["text", "lcov"] },
	},
});
