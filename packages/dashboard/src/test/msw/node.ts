import { setupServer } from "msw/node";
import { createHttpHandlers } from "./http-handlers";

/** MSW server for Vitest (HTTP only; tests fake the WebSocket). */
export const server = setupServer(...createHttpHandlers());
