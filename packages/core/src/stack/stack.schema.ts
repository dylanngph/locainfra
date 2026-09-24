import { publishedJsonSchema } from "../shared/json-schema";
import { StackFile } from "./stack.model";

/** Published JSON Schema of `locastack.yaml` (`schema/stack.v1.json`). */
export const stackJsonSchema: string = publishedJsonSchema(StackFile);
