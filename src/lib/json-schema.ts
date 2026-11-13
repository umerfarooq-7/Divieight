/**
 * A small JSON Schema (draft-07 subset) validator, with no dependency: type, required, properties, additionalProperties, items, enum, const,
 * pattern, minimum, maximum, minLength, minItems, format (uuid, date, date-time) and local $ref (#/definitions/...). It is what the Year-End
 * packet's schema is checked with, at generation and in the tests. Returns every problem with its path, not just the first.
 */
export type Schema = Record<string, any>;

const FORMATS: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
};

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const matches = (v: unknown, t: string) => typeOf(v) === t || (t === "number" && typeOf(v) === "integer");

export function validate(root: Schema, data: unknown): string[] {
  const errors: string[] = [];
  const resolve = (s: Schema): Schema => {
    if (!s.$ref) return s;
    const path = String(s.$ref).replace(/^#\//, "").split("/");
    let cur: any = root;
    for (const p of path) cur = cur?.[p];
    if (!cur) throw new Error(`Unresolved $ref ${s.$ref}`);
    return cur;
  };
  const walk = (schema: Schema, value: unknown, at: string) => {
    const s = resolve(schema);
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
    if (s.type) {
      const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => matches(value, t))) {
        errors.push(`${at}: must be ${types.join(" or ")}, not ${typeOf(value)}`);
        return;
      }
    }
    if (typeof value === "string") {
      if (s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${at}: does not match ${s.pattern}`);
      if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${at}: is shorter than ${s.minLength}`);
      if (s.format && FORMATS[s.format] && !FORMATS[s.format]!.test(value)) errors.push(`${at}: is not a ${s.format}`);
    }
    if (typeof value === "number") {
      if (s.minimum !== undefined && value < s.minimum) errors.push(`${at}: is below ${s.minimum}`);
      if (s.maximum !== undefined && value > s.maximum) errors.push(`${at}: is above ${s.maximum}`);
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${at}: needs at least ${s.minItems} item(s)`);
      if (s.items) value.forEach((v, i) => walk(s.items, v, `${at}[${i}]`));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const k of s.required ?? []) if (!(k in obj)) errors.push(`${at}.${k}: is required`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in obj) walk(sub as Schema, obj[k], `${at}.${k}`);
      if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
        for (const k of Object.keys(obj)) {
          if (s.properties && k in s.properties) continue;
          if (s.additionalProperties === false) errors.push(`${at}.${k}: is not allowed`);
          else walk(s.additionalProperties, obj[k], `${at}.${k}`);
        }
      }
    }
  };
  walk(root, data, "$");
  return errors;
}
