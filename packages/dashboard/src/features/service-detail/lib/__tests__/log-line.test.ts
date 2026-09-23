import { describe, expect, it } from "vitest";
import { detectLevel, parseLogLine } from "../log-line";

describe("parseLogLine", () => {
	it("strips a Postgres timestamp, pid and LEVEL: prefix", () => {
		expect(
			parseLogLine(
				"2026-09-23 06:59:05.152 UTC [42] LOG:  database system is ready to accept connections",
			),
		).toEqual({
			level: "LOG",
			message: "database system is ready to accept connections",
			plain: "database system is ready to accept connections",
		});
	});

	it("maps Postgres severities", () => {
		expect(
			parseLogLine("2026-09-23 06:59:05.152 UTC [7] FATAL:  role x").level,
		).toBe("ERROR");
		expect(
			parseLogLine("2026-09-23 06:59:05.152 UTC [7] WARNING:  careful").level,
		).toBe("WARN");
	});

	it("strips an ISO-8601 timestamp and uses the text level", () => {
		expect(parseLogLine("2026-09-23T06:59:05.152Z server listening")).toEqual({
			level: "INFO",
			message: "server listening",
			plain: "server listening",
		});
		expect(parseLogLine("[2026-09-23T06:59:05Z] [ERROR] boom").message).toBe(
			"boom",
		);
	});

	it("strips a Redis timestamp and maps its level marker", () => {
		expect(
			parseLogLine(
				"1:M 23 Sep 2026 06:59:05.152 * Ready to accept connections tcp",
			),
		).toMatchObject({
			level: "INFO",
			message: "Ready to accept connections tcp",
		});
		expect(
			parseLogLine("1:M 23 Sep 2026 06:59:05.152 # WARNING overcommit").level,
		).toBe("WARN");
	});

	it("returns no level for blank lines", () => {
		expect(parseLogLine("")).toEqual({ level: null, message: "", plain: "" });
		expect(parseLogLine("   ").level).toBeNull();
		expect(parseLogLine("\u001b[0m").level).toBeNull();
	});

	it("leaves lines without a known prefix intact", () => {
		expect(parseLogLine("Info about the thing")).toMatchObject({
			message: "Info about the thing",
		});
		expect(parseLogLine("PostgreSQL init process complete").level).toBe(
			detectLevel("PostgreSQL init process complete"),
		);
	});
});
