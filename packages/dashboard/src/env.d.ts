/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** `1` starts the MSW worker so the dashboard runs without a server. */
	readonly VITE_MOCK?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
