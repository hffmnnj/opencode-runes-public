export class RuneError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuneError";
    this.code = code;
  }
}

export const LIMITS = {
  sourceBytes: 262144,
  manifestBytes: 32768,
  outputBytes: 65536,
  catalogEntries: 1000,
  listLimit: 50,
  defaultTimeoutMs: 30000,
  maxTimeoutMs: 300000,
} as const;

export type Language = "javascript" | "typescript" | "python";

export type ParamType = "string" | "number" | "integer" | "boolean" | "path";

export type Entry = "main.js" | "main.ts" | "main.py";

export interface Param {
  type: ParamType;
  required?: boolean;
  default?: string | number | boolean;
  enum?: Array<string | number | boolean>;
  min?: number;
  max?: number;
  description?: string;
}

export type Params = Record<string, string | number | boolean>;

export type LegacyArgvEncoding = { mode: "flag"; when?: boolean } | { mode: "repeat-json" };

export interface RuneManifestLegacy {
  path: string;
  sha256: string;
  format: "caveman-blocks";
  example?: string[];
  metadata?: Record<string, unknown>;
  argv?: Record<string, LegacyArgvEncoding>;
}

export interface RuneManifest {
  version: 1;
  name: string;
  description: string;
  language: Language;
  interface: "native" | "argv";
  entry: Entry;
  params: Record<string, Param>;
  effects: string;
  timeoutMs?: number;
  legacy?: RuneManifestLegacy;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const LANGUAGES: ReadonlySet<string> = new Set(["javascript", "typescript", "python"]);
const PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "path"]);
const INTERFACES: ReadonlySet<string> = new Set(["native", "argv"]);
const ENTRIES: ReadonlySet<string> = new Set(["main.js", "main.ts", "main.py"]);

const MANIFEST_KEYS = new Set([
  "version",
  "name",
  "description",
  "language",
  "interface",
  "entry",
  "params",
  "effects",
  "timeoutMs",
  "legacy",
]);

const PARAM_KEYS = new Set(["type", "required", "default", "enum", "min", "max", "description"]);

const LEGACY_KEYS = new Set(["path", "sha256", "format", "example", "metadata", "argv"]);

const MAX_DESCRIPTION_CHARS = 1000;
const MAX_EFFECTS_CHARS = 120;
const MAX_PARAMS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code: string, message: string): never {
  throw new RuneError(code, message);
}

function assertNoPrototypeKey(keys: Iterable<string>, code: string, where: string): void {
  for (const key of keys) {
    if (PROTOTYPE_KEYS.has(key)) {
      fail(code, `${where}: forbidden prototype key ${JSON.stringify(key)}`);
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function valueMatchesType(type: ParamType, value: unknown): value is string | number | boolean {
  switch (type) {
    case "string":
    case "path":
      return typeof value === "string";
    case "number":
      return isFiniteNumber(value);
    case "integer":
      return isFiniteNumber(value) && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function checkBounds(code: "invalid_manifest" | "invalid_params", type: ParamType, value: string | number | boolean, min: number | undefined, max: number | undefined, where: string): void {
  if (min === undefined && max === undefined) return;
  if (type === "string" || type === "path") {
    const length = (value as string).length;
    if (min !== undefined && length < min) {
      fail(code, `${where}: length ${length} below min ${min}`);
    }
    if (max !== undefined && length > max) {
      fail(code, `${where}: length ${length} above max ${max}`);
    }
    return;
  }
  if (type === "number" || type === "integer") {
    const numeric = value as number;
    if (min !== undefined && numeric < min) {
      fail(code, `${where}: value ${numeric} below min ${min}`);
    }
    if (max !== undefined && numeric > max) {
      fail(code, `${where}: value ${numeric} above max ${max}`);
    }
  }
}

function checkParamsValue(
  code: "invalid_manifest" | "invalid_params",
  type: ParamType,
  value: unknown,
  def: { min?: number; max?: number; enum?: Array<string | number | boolean> },
  where: string,
): asserts value is string | number | boolean {
  if (!valueMatchesType(type, value)) {
    fail(code, `${where}: expected ${type}, received ${describeValue(value)}`);
  }
  checkBounds(code, type, value, def.min, def.max, where);
  if (def.enum !== undefined && !def.enum.includes(value as string | number | boolean)) {
    fail(code, `${where}: value not in enum`);
  }
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return String(value);
    return `number ${value}`;
  }
  if (typeof value === "boolean") return `boolean ${value}`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function isFiniteJson(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isFiniteJson);
  if (isPlainObject(value)) {
    return Object.entries(value).every(([key, entry]) => !PROTOTYPE_KEYS.has(key) && isFiniteJson(entry));
  }
  return false;
}

export function validateName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    fail("invalid_name", `invalid rune name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function entryFor(language: Language): Entry {
  switch (language) {
    case "javascript":
      return "main.js";
    case "typescript":
      return "main.ts";
    case "python":
      return "main.py";
    default:
      fail("invalid_language", `invalid language: ${JSON.stringify(language)}`);
  }
}

function validateParamDef(key: string, input: unknown): Param {
  const where = `param ${JSON.stringify(key)}`;
  if (!PARAM_NAME_RE.test(key)) {
    fail("invalid_manifest", `${where}: invalid parameter name`);
  }
  if (PROTOTYPE_KEYS.has(key)) {
    fail("invalid_manifest", `${where}: forbidden prototype key`);
  }
  if (!isPlainObject(input)) {
    fail("invalid_manifest", `${where}: parameter definition must be an object`);
  }
  for (const field of Object.keys(input)) {
    if (!PARAM_KEYS.has(field)) {
      fail("invalid_manifest", `${where}: unknown key ${JSON.stringify(field)}`);
    }
  }
  assertNoPrototypeKey(Object.keys(input), "invalid_manifest", where);

  const { type, required, default: defaultValue, enum: enumValues, min, max, description } = input as Record<string, unknown>;

  if (typeof type !== "string" || !PARAM_TYPES.has(type)) {
    fail("invalid_manifest", `${where}: invalid type ${JSON.stringify(type)}`);
  }
  const paramType = type as ParamType;

  if (required !== undefined && typeof required !== "boolean") {
    fail("invalid_manifest", `${where}: required must be a boolean`);
  }
  if (description !== undefined && typeof description !== "string") {
    fail("invalid_manifest", `${where}: description must be a string`);
  }
  if (min !== undefined && !isFiniteNumber(min)) {
    fail("invalid_manifest", `${where}: min must be a finite number`);
  }
  if (max !== undefined && !isFiniteNumber(max)) {
    fail("invalid_manifest", `${where}: max must be a finite number`);
  }
  if (paramType === "boolean" && (min !== undefined || max !== undefined)) {
    fail("invalid_manifest", `${where}: min/max do not apply to boolean parameters`);
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    fail("invalid_manifest", `${where}: min ${min} exceeds max ${max}`);
  }

  let validatedEnum: Array<string | number | boolean> | undefined;
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      fail("invalid_manifest", `${where}: enum must be a non-empty array`);
    }
    const seen = new Set<string | number | boolean>();
    for (const entry of enumValues as unknown[]) {
      if (!valueMatchesType(paramType, entry)) {
        fail("invalid_manifest", `${where}: enum value ${describeValue(entry)} does not match type ${paramType}`);
      }
      checkBounds("invalid_manifest", paramType, entry, min as number | undefined, max as number | undefined, `${where} enum`);
      if (seen.has(entry as string | number | boolean)) {
        fail("invalid_manifest", `${where}: duplicate enum value`);
      }
      seen.add(entry as string | number | boolean);
    }
    validatedEnum = [...(enumValues as Array<string | number | boolean>)];
  }

  if (defaultValue !== undefined) {
    checkParamsValue("invalid_manifest", paramType, defaultValue, { min: min as number | undefined, max: max as number | undefined, enum: validatedEnum }, `${where} default`);
  }

  const result: Param = { type: paramType };
  if (required !== undefined) result.required = required as boolean;
  if (defaultValue !== undefined) result.default = defaultValue as string | number | boolean;
  if (validatedEnum !== undefined) result.enum = validatedEnum;
  if (min !== undefined) result.min = min as number;
  if (max !== undefined) result.max = max as number;
  if (description !== undefined) result.description = description as string;
  return result;
}

function validateLegacy(input: unknown, params: Record<string, Param>): RuneManifestLegacy {
  if (!isPlainObject(input)) {
    fail("invalid_manifest", "legacy: must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!LEGACY_KEYS.has(key)) {
      fail("invalid_manifest", `legacy: unknown key ${JSON.stringify(key)}`);
    }
  }
  assertNoPrototypeKey(Object.keys(input), "invalid_manifest", "legacy");
  const { path, sha256, format, example, metadata } = input;

  if (typeof path !== "string" || path.length === 0) {
    fail("invalid_manifest", "legacy.path: must be a non-empty string");
  }
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    fail("invalid_manifest", "legacy.sha256: must be 64 hex characters");
  }
  if (format !== "caveman-blocks") {
    fail("invalid_manifest", `legacy.format: unsupported format ${JSON.stringify(format)}`);
  }
  let validatedExample: string[] | undefined;
  if (example !== undefined) {
    if (!Array.isArray(example) || !example.every((entry): entry is string => typeof entry === "string")) {
      fail("invalid_manifest", "legacy.example: must be an array of strings");
    }
    validatedExample = [...(example as string[])];
  }
  let validatedMetadata: Record<string, unknown> | undefined;
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) {
      fail("invalid_manifest", "legacy.metadata: must be an object");
    }
    assertNoPrototypeKey(Object.keys(metadata), "invalid_manifest", "legacy.metadata");
    if (!isFiniteJson(metadata)) {
      fail("invalid_manifest", "legacy.metadata: must be finite JSON");
    }
    validatedMetadata = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
  }

  const result: RuneManifestLegacy = {
    path: path as string,
    sha256: sha256 as string,
    format: "caveman-blocks",
  };
  if (validatedExample !== undefined) result.example = validatedExample;
  if (validatedMetadata !== undefined) result.metadata = validatedMetadata;
  if (input.argv !== undefined) {
    if (!isPlainObject(input.argv)) fail("invalid_manifest", "legacy.argv: must be an object");
    result.argv = {};
    for (const [key, encoding] of Object.entries(input.argv)) {
      if (!Object.hasOwn(params, key) || PROTOTYPE_KEYS.has(key) || !isPlainObject(encoding)) {
        fail("invalid_manifest", "legacy.argv: expected an encoding for a declared parameter");
      }
      if (encoding.mode === "flag") {
        if (params[key]!.type !== "boolean" || Object.keys(encoding).some(k => k !== "mode" && k !== "when")
          || (encoding.when !== undefined && typeof encoding.when !== "boolean")) {
          fail("invalid_manifest", "legacy.argv flag: expected boolean parameter and optional boolean when");
        }
        result.argv[key] = encoding.when === undefined ? { mode: "flag" } : { mode: "flag", when: encoding.when };
      } else if (encoding.mode === "repeat-json" && params[key]!.type === "string" && Object.keys(encoding).length === 1) {
        result.argv[key] = { mode: "repeat-json" };
      } else fail("invalid_manifest", "legacy.argv: unsupported encoding or parameter type");
    }
  }
  return result;
}

export function validateManifest(input: unknown): RuneManifest {
  if (!isPlainObject(input)) {
    fail("invalid_manifest", "manifest: must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) {
      fail("invalid_manifest", `manifest: unknown key ${JSON.stringify(key)}`);
    }
  }
  assertNoPrototypeKey(Object.keys(input), "invalid_manifest", "manifest");

  const { version, name, description, language, interface: iface, entry, params, effects, timeoutMs, legacy } = input;

  if (version !== 1) {
    fail("invalid_manifest", `manifest.version: expected 1, received ${JSON.stringify(version)}`);
  }
  if (typeof name !== "string") {
    fail("invalid_manifest", "manifest.name: must be a string");
  }
  validateName(name);

  if (typeof description !== "string") {
    fail("invalid_manifest", "manifest.description: must be a string");
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    fail("invalid_manifest", `manifest.description: exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  }

  if (typeof language !== "string" || !LANGUAGES.has(language)) {
    fail("invalid_manifest", `manifest.language: invalid language ${JSON.stringify(language)}`);
  }
  if (typeof iface !== "string" || !INTERFACES.has(iface)) {
    fail("invalid_manifest", `manifest.interface: invalid interface ${JSON.stringify(iface)}`);
  }
  if (typeof entry !== "string" || !ENTRIES.has(entry)) {
    fail("invalid_manifest", `manifest.entry: invalid entry ${JSON.stringify(entry)}`);
  }
  if (entry !== entryFor(language as Language)) {
    fail("invalid_manifest", `manifest.entry: ${JSON.stringify(entry)} does not match language ${JSON.stringify(language)}`);
  }

  if (!isPlainObject(params)) {
    fail("invalid_manifest", "manifest.params: must be an object");
  }
  const paramKeys = Object.keys(params);
  if (paramKeys.length > MAX_PARAMS) {
    fail("invalid_manifest", `manifest.params: exceeds ${MAX_PARAMS} parameters`);
  }
  const validatedParams: Record<string, Param> = {};
  for (const key of paramKeys) {
    validatedParams[key] = validateParamDef(key, (params as Record<string, unknown>)[key]);
  }

  if (typeof effects !== "string") {
    fail("invalid_manifest", "manifest.effects: must be a string");
  }
  if (effects.length > MAX_EFFECTS_CHARS) {
    fail("invalid_manifest", `manifest.effects: exceeds ${MAX_EFFECTS_CHARS} characters`);
  }

  let validatedTimeout: number | undefined;
  if (timeoutMs !== undefined) {
    if (!isFiniteNumber(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.maxTimeoutMs) {
      fail("invalid_manifest", `manifest.timeoutMs: must be an integer from 1 to ${LIMITS.maxTimeoutMs}`);
    }
    validatedTimeout = timeoutMs;
  }

  let validatedLegacy: RuneManifestLegacy | undefined;
  if (legacy !== undefined) {
    validatedLegacy = validateLegacy(legacy, validatedParams);
  }
  if (iface === "argv") {
    for (const [key, def] of Object.entries(validatedParams)) {
      if (def.type === "boolean" && validatedLegacy?.argv?.[key]?.mode !== "flag") {
        fail("invalid_manifest", "Boolean argv encoding is ambiguous; explicit legacy.argv flag required");
      }
    }
  }

  const manifest: RuneManifest = {
    version: 1,
    name,
    description,
    language: language as Language,
    interface: iface as "native" | "argv",
    entry: entry as Entry,
    params: validatedParams,
    effects,
  };
  if (validatedTimeout !== undefined) manifest.timeoutMs = validatedTimeout;
  if (validatedLegacy !== undefined) manifest.legacy = validatedLegacy;
  return manifest;
}

export function validateParams(manifest: RuneManifest, input: unknown): Params {
  if (input === undefined) {
    input = {};
  }
  if (!isPlainObject(input)) {
    fail("invalid_params", "params: must be an object");
  }
  assertNoPrototypeKey(Object.keys(input), "invalid_params", "params");

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(manifest.params, key)) {
      fail("invalid_params", `unknown parameter: ${JSON.stringify(key)}`);
    }
  }

  const result: Params = {};
  for (const [key, def] of Object.entries(manifest.params)) {
    const hasValue = Object.hasOwn(input, key);
    const supplied = hasValue ? (input as Record<string, unknown>)[key] : undefined;
    if (!hasValue || supplied === undefined) {
      if (def.default !== undefined) {
        result[key] = def.default;
      } else if (def.required === true) {
        fail("invalid_params", `missing required parameter: ${JSON.stringify(key)}`);
      }
      continue;
    }
    checkParamsValue("invalid_params", def.type, supplied, def, `param ${JSON.stringify(key)}`);
    result[key] = supplied as string | number | boolean;
  }
  return result;
}
