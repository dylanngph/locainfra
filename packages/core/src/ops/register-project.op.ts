import { join } from "node:path";
import { OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadStack } from "../stack/loader";
import { PROJECT_STACK_FILE_NAME } from "../stack/stack.model";
import type { RegisterProject } from "./ops.contract";
import { checkProjectInput, registerStack } from "./support/registration";

/**
 * Registers an existing project folder (containing a valid
 * `locastack.yaml` whose `name` equals `input.name`) in `state.json`.
 * Re-registering the same folder is a no-op success; a folder registered
 * under another name is re-registered under its current one.
 *
 * @returns The registry entry; `INVALID_INPUT` (bad name, relative root,
 *   name mismatch), `STACK_NOT_FOUND`, `INVALID_STACK`, `PROJECT_EXISTS`
 *   (name held by another folder, or a container name clash) or `IO`.
 */
export const registerProject: RegisterProject = async (deps, input) => {
	const root = checkProjectInput(input.name, input.root);
	if (!root.ok) return root;
	const filePath = join(root.value, PROJECT_STACK_FILE_NAME);
	const loaded = await loadStack(deps.files, { filePath, root: root.value });
	if (!loaded.ok) return loaded;
	if (loaded.value.name !== input.name) {
		return err(
			new OpError(
				"INVALID_INPUT",
				`${filePath} declares name "${loaded.value.name}", not "${input.name}"`,
				{
					details: {
						name: input.name,
						fileName: loaded.value.name,
						filePath,
						fix: `Register it as "${loaded.value.name}", or change "name:" in ${filePath}.`,
					},
				},
			),
		);
	}
	const registered = await registerStack(deps, loaded.value);
	if (!registered.ok) return registered;
	return ok({ name: input.name, root: root.value });
};
