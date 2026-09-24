import type { Clock } from "@locastack/core";

/** {@link Clock} backed by the system wall clock. */
export class SystemClock implements Clock {
	/** @returns The current system time. */
	now(): Date {
		return new Date();
	}
}
