/// <reference types="vitest/config" />
import { rm } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const API_TARGET = process.env.LOCAINFRA_API ?? "http://127.0.0.1:4488";
const here = import.meta.dirname;

/** The MSW worker only serves `VITE_MOCK=1` dev sessions; keep it out of the build. */
const dropMockWorker = (): Plugin => ({
	name: "locainfra:drop-mock-worker",
	apply: "build",
	async closeBundle() {
		await rm(path.resolve(here, "dist/mockServiceWorker.js"), { force: true });
	},
});

export default defineConfig({
	envDir: path.resolve(import.meta.dirname, "../.."),
	plugins: [react(), tailwindcss(), dropMockWorker()],
	resolve: {
		alias: { "@": path.resolve(here, "./src") },
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
		environmentOptions: { happyDOM: { url: "http://127.0.0.1:4488/" } },
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		coverage: { provider: "v8", reporter: ["text", "lcov"] },
	},
});
