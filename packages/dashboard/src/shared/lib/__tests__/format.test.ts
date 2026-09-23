import { describe, expect, it } from "vitest";
import { formatCpu, formatMem, formatReading, NO_READING } from "../format";

describe("formatReading", () => {
	it("shows — for a missing reading instead of 0", () => {
		expect(formatReading(undefined, formatCpu)).toBe(NO_READING);
		expect(formatReading(undefined, formatMem)).toBe("—");
	});

	it("formats real readings, including a real 0", () => {
		expect(formatReading(0, formatCpu)).toBe("0.0%");
		expect(formatReading(2.44, formatCpu)).toBe("2.4%");
		expect(formatReading(312 * 1024 * 1024, formatMem)).toBe("312 MB");
	});
});
