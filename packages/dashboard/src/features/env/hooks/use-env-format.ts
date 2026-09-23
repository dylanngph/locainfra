import { parseAsStringLiteral, useQueryState } from "nuqs";
import { ENV_FORMATS } from "../api/env.queries";

/** `?fmt=` of the Environment page (default `dotenv`). */
export const useEnvFormat = () =>
	useQueryState("fmt", parseAsStringLiteral(ENV_FORMATS).withDefault("dotenv"));
