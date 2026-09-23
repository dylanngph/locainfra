import { describe, expect, it, vi } from "vitest";
import { initSessionToken, TOKEN_STORAGE_KEY } from "../session-token";

const env = (href: string, stored: string | null = null) => {
	const store = new Map<string, string>(
		stored ? [[TOKEN_STORAGE_KEY, stored]] : [],
	);
	return {
		location: { href },
		storage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		},
		history: { state: null, replaceState: vi.fn() },
		store,
	};
};

describe("initSessionToken", () => {
	it("takes ?t=, persists it and strips it from the URL", () => {
		const e = env("http://127.0.0.1:4488/p/shop?t=abc&tab=logs");
		expect(initSessionToken(e)).toBe("abc");
		expect(e.store.get(TOKEN_STORAGE_KEY)).toBe("abc");
		expect(e.history.replaceState).toHaveBeenCalledWith(
			null,
			"",
			"/p/shop?tab=logs",
		);
	});

	it("falls back to the stored token", () => {
		const e = env("http://127.0.0.1:4488/", "stored");
		expect(initSessionToken(e)).toBe("stored");
		expect(e.history.replaceState).not.toHaveBeenCalled();
	});
});
