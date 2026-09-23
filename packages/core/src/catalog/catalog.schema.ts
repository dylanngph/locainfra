import { publishedJsonSchema } from "../shared/json-schema";
import { ServiceDefinition } from "./catalog.model";

/** Published JSON Schema of a catalog definition (`schema/service.v1.json`). */
export const serviceJsonSchema: string = publishedJsonSchema(ServiceDefinition);
