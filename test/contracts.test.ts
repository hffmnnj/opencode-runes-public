import { describe, expect, it } from "bun:test";
import {
  LIMITS,
  RuneError,
  entryFor,
  validateManifest,
  validateName,
  validateParams,
  type RuneManifest,
} from "../src/contracts.ts";

function validManifestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "word-count",
    description: "Count words in a file",
    language: "python",
    interface: "native",
    entry: "main.py",
    params: {},
    effects: "read",
    ...overrides,
  };
}

function manifestWithParams(params: Record<string, unknown>): RuneManifest {
  return validateManifest(validManifestInput({ params }));
}

describe("validateName", () => {
  it("accepts_minimal_and_maximal_names", () => {
    expect(validateName("a")).toBe("a");
    expect(validateName("rune-123")).toBe("rune-123");
    expect(validateName("a".padEnd(64, "b"))).toBe("a".padEnd(64, "b"));
  });

  it("rejects_malformed_names", () => {
    for (const bad of ["", "A", "0abc", "-abc", "has space", "has_under", "UPPER", "a".padEnd(65, "b")]) {
      expect(() => validateName(bad)).toThrowError(RuneError);
    }
  });

  it("rejects_malformed_name_with_invalid_name_code", () => {
    try {
      validateName("Bad Name");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("invalid_name");
    }
  });
});

describe("entryFor", () => {
  it("maps_each_language_to_its_entry", () => {
    expect(entryFor("javascript")).toBe("main.js");
    expect(entryFor("typescript")).toBe("main.ts");
    expect(entryFor("python")).toBe("main.py");
  });

  it("rejects_unknown_language", () => {
    expect(() => entryFor("ruby" as never)).toThrowError(RuneError);
  });
});

describe("limits", () => {
  it("exposes_settled_limit_values", () => {
    expect(LIMITS).toEqual({
      sourceBytes: 262144,
      manifestBytes: 32768,
      outputBytes: 65536,
      catalogEntries: 1000,
      listLimit: 50,
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 300000,
    });
  });
});

describe("validateManifest_structure", () => {
  it("accepts_minimal_valid_manifest", () => {
    const manifest = validateManifest(validManifestInput());
    expect(manifest.name).toBe("word-count");
    expect(manifest.entry).toBe("main.py");
    expect(manifest.params).toEqual({});
  });

  it("rejects_unknown_top_level_key", () => {
    expect(() => validateManifest(validManifestInput({ author: "james" }))).toThrowError(/unknown key/);
  });

  it("rejects_unknown_param_key", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { q: { type: "string", widget: "text" } } })),
    ).toThrowError(/unknown key/);
  });

  it("rejects_mismatched_entry_for_language", () => {
    expect(() => validateManifest(validManifestInput({ language: "python", entry: "main.js" }))).toThrowError(
      /does not match language/,
    );
  });

  it("rejects_prototype_keys_in_params", () => {
    const tainted = JSON.parse('{"__proto__":{"type":"string"}}') as Record<string, unknown>;
    expect(() => validateManifest(validManifestInput({ params: tainted }))).toThrowError(RuneError);
  });

  it("rejects_more_than_64_params", () => {
    const params: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) params[`p${index}`] = { type: "string" };
    expect(() => validateManifest(validManifestInput({ params }))).toThrowError(/exceeds 64/);
  });

  it("rejects_overlong_description_and_effects", () => {
    expect(() => validateManifest(validManifestInput({ description: "x".repeat(1001) }))).toThrowError(/description/);
    expect(() => validateManifest(validManifestInput({ effects: "x".repeat(121) }))).toThrowError(/effects/);
  });

  it("rejects_invalid_and_out_of_range_timeout", () => {
    expect(() => validateManifest(validManifestInput({ timeoutMs: 0 }))).toThrowError(/timeoutMs/);
    expect(() => validateManifest(validManifestInput({ timeoutMs: 1.5 }))).toThrowError(/timeoutMs/);
    expect(() => validateManifest(validManifestInput({ timeoutMs: LIMITS.maxTimeoutMs + 1 }))).toThrowError(
      /timeoutMs/,
    );
  });

  it("retains_legacy_metadata_but_rejects_unknown_legacy_keys", () => {
    const sha = "a".repeat(64);
    const manifest = validateManifest(
      validManifestInput({
        legacy: { path: "old.block", sha256: sha, format: "caveman-blocks", metadata: { help: "kept" } },
      }),
    );
    expect(manifest.legacy?.metadata).toEqual({ help: "kept" });
    expect(() =>
      validateManifest(
        validManifestInput({ legacy: { path: "old.block", sha256: sha, format: "caveman-blocks", extra: 1 } }),
      ),
    ).toThrowError(/unknown key/);
  });
});

describe("validateManifest_param_defaults_and_enums", () => {
  it("rejects_default_with_wrong_type", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { n: { type: "integer", default: "five" } } })),
    ).toThrowError(/default/);
  });

  it("rejects_enum_values_with_wrong_type", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { n: { type: "integer", enum: [1, "two"] } } })),
    ).toThrowError(/enum/);
  });

  it("rejects_default_outside_declared_bounds", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { n: { type: "integer", min: 1, max: 5, default: 9 } } })),
    ).toThrowError(/default/);
  });

  it("rejects_enum_value_outside_declared_bounds", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { n: { type: "integer", min: 1, max: 5, enum: [2, 9] } } })),
    ).toThrowError(/enum/);
  });

  it("rejects_default_missing_from_enum", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { color: { type: "string", enum: ["red", "blue"], default: "green" } } })),
    ).toThrowError(/enum/);
  });

  it("rejects_min_max_on_boolean_and_inverted_range", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { flag: { type: "boolean", min: 0 } } })),
    ).toThrowError(/boolean/);
    expect(() =>
      validateManifest(validManifestInput({ params: { n: { type: "integer", min: 5, max: 1 } } })),
    ).toThrowError(/exceeds max/);
  });

  it("rejects_nonfinite_default_and_metadata", () => {
    expect(() =>
      validateManifest(validManifestInput({ params: { n: { type: "number", default: Number.POSITIVE_INFINITY } } })),
    ).toThrowError(RuneError);
    expect(() =>
      validateManifest(
        validManifestInput({
          legacy: {
            path: "old.block",
            sha256: "b".repeat(64),
            format: "caveman-blocks",
            metadata: { score: Number.NaN },
          },
        }),
      ),
    ).toThrowError(/finite/);
  });
});

describe("validateParams_behavior", () => {
  it("applies_defaults_for_missing_optional_params", () => {
    const manifest = manifestWithParams({
      greeting: { type: "string", default: "hello" },
      retries: { type: "integer", default: 3 },
    });
    expect(validateParams(manifest, {})).toEqual({ greeting: "hello", retries: 3 });
    expect(validateParams(manifest, undefined)).toEqual({ greeting: "hello", retries: 3 });
  });

  it("rejects_unknown_params", () => {
    const manifest = manifestWithParams({ known: { type: "string" } });
    expect(() => validateParams(manifest, { known: "yes", surprise: 1 })).toThrowError(/unknown parameter/);
  });

  it("rejects_missing_required_param", () => {
    const manifest = manifestWithParams({ token: { type: "string", required: true } });
    expect(() => validateParams(manifest, {})).toThrowError(/missing required/);
  });

  it("does_not_coerce_types", () => {
    const manifest = manifestWithParams({ count: { type: "integer", required: true } });
    expect(() => validateParams(manifest, { count: "3" })).toThrowError(/expected integer/);
    expect(() => validateParams(manifest, { count: 3.5 })).toThrowError(/expected integer/);
    expect(validateParams(manifest, { count: 3 })).toEqual({ count: 3 });
  });

  it("enforces_string_length_and_numeric_bounds", () => {
    const manifest = manifestWithParams({
      title: { type: "string", min: 2, max: 4, required: true },
      level: { type: "integer", min: 1, max: 5, required: true },
    });
    expect(() => validateParams(manifest, { title: "x", level: 3 })).toThrowError(RuneError);
    expect(() => validateParams(manifest, { title: "toolong", level: 3 })).toThrowError(RuneError);
    expect(() => validateParams(manifest, { title: "ok", level: 0 })).toThrowError(RuneError);
    expect(validateParams(manifest, { title: "ok", level: 5 })).toEqual({ title: "ok", level: 5 });
  });

  it("reports_bound_violations_as_invalid_params", () => {
    const manifest = manifestWithParams({
      title: { type: "string", min: 2, max: 4, required: true },
      level: { type: "integer", min: 1, max: 5, required: true },
    });
    for (const params of [
      { title: "x", level: 3 },
      { title: "toolong", level: 3 },
      { title: "ok", level: 0 },
      { title: "ok", level: 6 },
    ]) {
      try {
        validateParams(manifest, params);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RuneError);
        expect((error as RuneError).code).toBe("invalid_params");
      }
    }
  });

  it("reports_manifest_bound_violations_as_invalid_manifest", () => {
    try {
      validateManifest(
        validManifestInput({ params: { n: { type: "integer", min: 1, max: 5, default: 9 } } }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuneError);
      expect((error as RuneError).code).toBe("invalid_manifest");
    }
  });

  it("enforces_enum_membership", () => {
    const manifest = manifestWithParams({ mode: { type: "string", enum: ["fast", "slow"], required: true } });
    expect(() => validateParams(manifest, { mode: "medium" })).toThrowError(/enum/);
    expect(validateParams(manifest, { mode: "fast" })).toEqual({ mode: "fast" });
  });

  it("rejects_nonfinite_numbers", () => {
    const manifest = manifestWithParams({ ratio: { type: "number", required: true } });
    expect(() => validateParams(manifest, { ratio: Number.NaN })).toThrowError(RuneError);
    expect(() => validateParams(manifest, { ratio: Number.POSITIVE_INFINITY })).toThrowError(RuneError);
  });

  it("rejects_prototype_pollution_keys", () => {
    const manifest = manifestWithParams({ safe: { type: "string" } });
    const polluted = JSON.parse('{"safe":"ok","__proto__":"polluted"}') as Record<string, unknown>;
    expect(() => validateParams(manifest, polluted)).toThrowError(RuneError);
  });

  it("keeps_path_as_distinct_string_type_without_coercion", () => {
    const manifest = manifestWithParams({ target: { type: "path", required: true } });
    expect(validateParams(manifest, { target: "notes/file.md" })).toEqual({ target: "notes/file.md" });
    expect(() => validateParams(manifest, { target: 42 })).toThrowError(/expected path/);
  });
});
