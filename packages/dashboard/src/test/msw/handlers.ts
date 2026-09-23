import { createHttpHandlers } from "./http-handlers";
import { createWsHandlers } from "./ws-handlers";

/** Every mock handler (HTTP + WebSocket) over the shared mock backend. */
export const handlers = [...createHttpHandlers(), ...createWsHandlers()];
