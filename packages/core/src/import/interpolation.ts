/**
 * Evaluates compose variable interpolation without any environment: `$$`
 * is a literal `$`; `${VAR:-default}` and `${VAR-default}` become their
 * default (which may not itself interpolate); anything else that reads a
 * variable (`$VAR`, `${VAR}`, `${VAR:?err}`, `${VAR:+alt}`) cannot be known
 * and makes the whole value unknown.
 *
 * @param value - A compose string value.
 * @returns The value with defaults applied, or `undefined` when it depends
 *   on the environment.
 */
export function interpolateDefaults(value: string): string | undefined {
	let out = "";
	let i = 0;
	while (i < value.length) {
		const c = value[i];
		if (c !== "$") {
			out += c;
			i++;
			continue;
		}
		const next = value[i + 1];
		if (next === "$") {
			out += "$";
			i += 2;
			continue;
		}
		if (next !== "{") {
			// `$VAR` reads the environment; a lone `$` at the end is literal.
			if (next !== undefined && /[A-Za-z_]/.test(next)) return undefined;
			out += "$";
			i++;
			continue;
		}
		const close = value.indexOf("}", i + 2);
		if (close === -1) return undefined;
		const body = value.slice(i + 2, close);
		const match = /^[A-Za-z_][A-Za-z0-9_]*(:?-)(.*)$/s.exec(body);
		const fallback = match?.[2];
		if (fallback === undefined || fallback.includes("$")) return undefined;
		out += fallback;
		i = close + 1;
	}
	return out;
}
