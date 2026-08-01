import { describe, expect, it } from "vitest";
import {
  FIRESTORE_VALUE_TAGS,
  FirestoreValueError,
  type FirestoreValue,
  decodeFields,
  decodeValue,
  encodeFields,
  encodeValue,
} from "../src/value";

/**
 * The codec is PURE, so this suite is exhaustive and needs no network, no emulator and no
 * Google project. Every one of the eleven wire tags is tested in BOTH directions.
 */

describe("encodeValue — every Firestore type", () => {
  it("encodes the primitive types", () => {
    expect(encodeValue(null)).toEqual({ nullValue: null });
    expect(encodeValue(true)).toEqual({ booleanValue: true });
    expect(encodeValue(false)).toEqual({ booleanValue: false });
    expect(encodeValue("ada")).toEqual({ stringValue: "ada" });
    expect(encodeValue("")).toEqual({ stringValue: "" });
  });

  it("encodes an integer as a STRING — the wire-format trap", () => {
    // This is the single most important assertion in the file. integerValue is a JSON
    // STRING, not a JSON number; emitting a number here makes Firestore reject the write.
    expect(encodeValue(5)).toEqual({ integerValue: "5" });
    expect(encodeValue(5).integerValue).toBeTypeOf("string");
    expect(encodeValue(0)).toEqual({ integerValue: "0" });
    expect(encodeValue(-42)).toEqual({ integerValue: "-42" });
  });

  it("encodes a non-integral number as a double", () => {
    expect(encodeValue(5.5)).toEqual({ doubleValue: 5.5 });
    expect(encodeValue(-0.25)).toEqual({ doubleValue: -0.25 });
    expect(encodeValue(5.5).doubleValue).toBeTypeOf("number");
  });

  it("gates on isSafeInteger, NOT isInteger — 1e21 must not become '1e+21'", () => {
    // Number.isInteger(1e21) is true, and String(1e21) === "1e+21", which is not a decimal
    // string and Firestore rejects it outright. isSafeInteger is the correct gate.
    expect(Number.isInteger(1e21)).toBe(true);
    expect(encodeValue(1e21)).toEqual({ doubleValue: 1e21 });

    // 2**53 is the first unsafe integer.
    expect(encodeValue(2 ** 53)).toEqual({ doubleValue: 2 ** 53 });
    expect(encodeValue(2 ** 53 - 1)).toEqual({
      integerValue: "9007199254740991",
    });

    // Nothing that failed the gate may ever be stringified.
    for (const n of [1e21, 2 ** 53, 1e300]) {
      const encoded = encodeValue(n) as { doubleValue?: number };
      expect(encoded.doubleValue, `${n} must be a double`).toBeTypeOf("number");
    }
  });

  it("treats -0 as the integer 0", () => {
    expect(Number.isSafeInteger(-0)).toBe(true);
    expect(encodeValue(-0)).toEqual({ integerValue: "0" });
  });

  it("rejects NaN and Infinity — neither has a JSON representation", () => {
    expect(() => encodeValue(NaN)).toThrow(FirestoreValueError);
    expect(() => encodeValue(Infinity)).toThrow(/no JSON representation/);
    expect(() => encodeValue(-Infinity)).toThrow(FirestoreValueError);
  });

  it("encodes bigint, Date and bytes", () => {
    expect(encodeValue(123n)).toEqual({ integerValue: "123" });
    // A bigint beyond 2^53 is exactly why bigint is supported at all.
    expect(encodeValue(9007199254740993n)).toEqual({
      integerValue: "9007199254740993",
    });
    expect(encodeValue(new Date("2026-01-02T03:04:05.000Z"))).toEqual({
      timestampValue: "2026-01-02T03:04:05.000Z",
    });
    expect(() => encodeValue(new Date("nope"))).toThrow(/Invalid Date/);
    expect(encodeValue(new Uint8Array([1, 2, 3]))).toEqual({
      bytesValue: "AQID",
    });
  });

  it("recurses through arrays and nested maps", () => {
    expect(encodeValue([1, "a", null])).toEqual({
      arrayValue: {
        values: [
          { integerValue: "1" },
          { stringValue: "a" },
          { nullValue: null },
        ],
      },
    });
    expect(encodeValue([])).toEqual({ arrayValue: { values: [] } });
    expect(encodeValue({ a: { b: [true] } })).toEqual({
      mapValue: {
        fields: {
          a: {
            mapValue: {
              fields: {
                b: { arrayValue: { values: [{ booleanValue: true }] } },
              },
            },
          },
        },
      },
    });
  });

  it("names the offending path when it refuses a value", () => {
    expect(() => encodeValue({ a: [1, NaN] })).toThrow(/at \$\.a\[1\]/);
  });

  it("rejects a value with no Firestore equivalent", () => {
    expect(() => encodeValue(() => 1)).toThrow(FirestoreValueError);
    expect(() => encodeValue(Symbol("s"))).toThrow(FirestoreValueError);
  });

  it("drops undefined-valued keys, matching JSON.stringify", () => {
    expect(encodeFields({ a: 1, b: undefined })).toEqual({
      a: { integerValue: "1" },
    });
  });
});

describe("decodeValue — every Firestore type", () => {
  it("decodes the primitive types", () => {
    expect(decodeValue({ nullValue: null })).toBeNull();
    expect(decodeValue({ booleanValue: true })).toBe(true);
    expect(decodeValue({ stringValue: "ada" })).toBe("ada");
    expect(decodeValue({ integerValue: "5" })).toBe(5);
    expect(decodeValue({ doubleValue: 5.5 })).toBe(5.5);
  });

  it("keeps an unsafe integer as a decimal string rather than losing precision", () => {
    // 9007199254740993 cannot be a JS number. Returning 9007199254740992 would be a
    // silent, unrecoverable corruption of someone's id.
    expect(decodeValue({ integerValue: "9007199254740993" })).toBe(
      "9007199254740993",
    );
    expect(decodeValue({ integerValue: "9007199254740991" })).toBe(
      9007199254740991,
    );
  });

  it("tolerates an integerValue that arrives as a number", () => {
    expect(decodeValue({ integerValue: 7 } as unknown as FirestoreValue)).toBe(
      7,
    );
  });

  it("passes NaN/Infinity doubles through as their proto3 JSON strings", () => {
    expect(
      decodeValue({ doubleValue: "NaN" } as unknown as FirestoreValue),
    ).toBe("NaN");
    expect(
      decodeValue({ doubleValue: "Infinity" } as unknown as FirestoreValue),
    ).toBe("Infinity");
  });

  it("decodes timestamp/bytes/reference to their natural readable form", () => {
    expect(decodeValue({ timestampValue: "2026-01-02T03:04:05Z" })).toBe(
      "2026-01-02T03:04:05Z",
    );
    expect(decodeValue({ bytesValue: "AQID" })).toBe("AQID");
    expect(
      decodeValue({
        referenceValue: "projects/p/databases/(default)/documents/u/1",
      }),
    ).toBe("projects/p/databases/(default)/documents/u/1");
  });

  it("defaults an omitted geo point coordinate to 0 (proto3 drops zero fields)", () => {
    // The geo point (0, 0) really does arrive on the wire as `{}`.
    expect(decodeValue({ geoPointValue: {} })).toEqual({
      latitude: 0,
      longitude: 0,
    });
    expect(decodeValue({ geoPointValue: { latitude: 51.5 } })).toEqual({
      latitude: 51.5,
      longitude: 0,
    });
  });

  it("decodes an omitted arrayValue.values / mapValue.fields as empty", () => {
    expect(decodeValue({ arrayValue: {} })).toEqual([]);
    expect(decodeValue({ mapValue: {} })).toEqual({});
  });

  it("throws on an unrecognized tag rather than returning undefined", () => {
    expect(() =>
      decodeValue({ bogusValue: 1 } as unknown as FirestoreValue),
    ).toThrow(/Unrecognized Firestore value tag/);
  });

  it("keeps a __proto__ field as an own property WITHOUT polluting (#591)", () => {
    // Build the input with defineProperty: a `__proto__` key in an OBJECT LITERAL sets the
    // prototype instead of becoming an own key, so a literal would not test anything.
    // JSON.parse produces a real own `__proto__` key, which is exactly what arrives from
    // the Firestore REST response.
    const raw = JSON.parse(
      '{"__proto__":{"stringValue":"polluted"},"ok":{"integerValue":"1"}}',
    ) as Record<string, FirestoreValue>;
    expect(Object.keys(raw)).toContain("__proto__");

    const decoded = decodeFields(raw);

    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toBe(
      "polluted",
    );
    expect(decoded.ok).toBe(1);
    // The prototype chain is untouched, which is the whole point.
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("round-trip fidelity", () => {
  const CASES: Array<[string, unknown]> = [
    ["null", null],
    ["true", true],
    ["false", false],
    ["empty string", ""],
    ["string", "ada lovelace"],
    ["unicode string", "héllo 🌍"],
    ["zero", 0],
    ["positive integer", 42],
    ["negative integer", -42],
    ["max safe integer", Number.MAX_SAFE_INTEGER],
    ["min safe integer", Number.MIN_SAFE_INTEGER],
    ["double", 5.5],
    ["negative double", -0.125],
    ["tiny double", 1e-300],
    ["huge double", 1e21],
    ["empty array", []],
    ["flat array", [1, 2, 3]],
    ["mixed array", [1, "a", true, null, 2.5]],
    ["nested array", [[1], [[2]]]],
    ["empty object", {}],
    ["flat object", { a: 1, b: "two", c: false, d: null }],
    ["nested object", { a: { b: { c: [1, { d: "e" }] } } }],
    ["object with dotted keys", { "a.b": 1 }],
    ["object with unicode keys", { ключ: "значение" }],
  ];

  it.each(CASES)("round-trips %s exactly", (_label, value) => {
    expect(decodeValue(encodeValue(value))).toEqual(value);
  });

  it("round-trips every case as document fields too", () => {
    const doc = Object.fromEntries(
      CASES.map(([label, value]) => [label, value]),
    );
    expect(decodeFields(encodeFields(doc))).toEqual(doc);
  });

  /**
   * The property test: decode ∘ encode is the identity on ALL of plain JSON. Seeded so a
   * failure is reproducible rather than a flake.
   */
  it("decode(encode(v)) === v for randomly generated plain JSON", () => {
    let seed = 0x5eed;
    const rnd = () => {
      // xorshift — deterministic, no Math.random.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 0x7fffffff;
    };
    const pick = <T>(arr: T[]): T =>
      arr[Math.floor(rnd() * arr.length) % arr.length] as T;

    const gen = (depth: number): unknown => {
      const kinds =
        depth <= 0
          ? ["null", "bool", "int", "double", "string"]
          : ["null", "bool", "int", "double", "string", "array", "object"];
      switch (pick(kinds)) {
        case "null":
          return null;
        case "bool":
          return rnd() > 0.5;
        case "int":
          return Math.floor((rnd() - 0.5) * 2 * Number.MAX_SAFE_INTEGER);
        case "double":
          return (rnd() - 0.5) * 1e6 + 0.5;
        case "string":
          return pick(["", "a", "ada", "héllo 🌍", "with space", "1"]);
        case "array":
          return Array.from({ length: Math.floor(rnd() * 4) }, () =>
            gen(depth - 1),
          );
        default: {
          const out: Record<string, unknown> = {};
          for (let i = 0; i < Math.floor(rnd() * 4); i++) {
            out[pick(["a", "b", "c", "d.e", "ключ"])] = gen(depth - 1);
          }
          return out;
        }
      }
    };

    for (let i = 0; i < 500; i++) {
      const value = gen(4);
      expect(decodeValue(encodeValue(value)), `iteration ${i}`).toEqual(value);
    }
  });
});

describe("typed literals (opt-in escape hatch)", () => {
  it("is OFF by default, so {stringValue} is ordinary data and round-trips", () => {
    // This is the collision the flag exists to keep shut: anyone who has dumped a
    // Firestore export into a document field really does have objects of this shape.
    const value = { stringValue: "x" };
    expect(encodeValue(value)).toEqual({
      mapValue: { fields: { stringValue: { stringValue: "x" } } },
    });
    expect(decodeValue(encodeValue(value))).toEqual(value);
  });

  it("ON, the same object is reinterpreted as a literal — the pinned collision", () => {
    const value = { stringValue: "x" };
    expect(encodeValue(value, { typedValues: true })).toEqual({
      stringValue: "x",
    });
    // ...and therefore does NOT round-trip. Documented, deliberate, and the reason the
    // flag defaults to off.
    expect(decodeValue(encodeValue(value, { typedValues: true }))).toBe("x");
  });

  it("forces a double for a whole number — the only way to express 1.0", () => {
    expect(encodeValue(1, { typedValues: true })).toEqual({
      integerValue: "1",
    });
    expect(encodeValue({ doubleValue: 1 }, { typedValues: true })).toEqual({
      doubleValue: 1,
    });
  });

  it("writes geo points, references and timestamps", () => {
    expect(
      encodeValue(
        { geoPointValue: { latitude: 51.5, longitude: -0.12 } },
        { typedValues: true },
      ),
    ).toEqual({ geoPointValue: { latitude: 51.5, longitude: -0.12 } });

    expect(
      encodeValue(
        { timestampValue: "2026-01-02T03:04:05Z" },
        { typedValues: true },
      ),
    ).toEqual({ timestampValue: "2026-01-02T03:04:05Z" });

    expect(
      encodeValue(
        { referenceValue: "projects/p/databases/(default)/documents/u/1" },
        {
          typedValues: true,
        },
      ),
    ).toEqual({
      referenceValue: "projects/p/databases/(default)/documents/u/1",
    });
  });

  it("validates a literal's contents rather than trusting the tag", () => {
    const on = { typedValues: true };
    expect(() => encodeValue({ integerValue: "abc" }, on)).toThrow(
      /decimal string/,
    );
    expect(() => encodeValue({ integerValue: 2 ** 53 }, on)).toThrow(
      /safe integer/,
    );
    expect(() => encodeValue({ doubleValue: "nope" }, on)).toThrow(
      /finite number/,
    );
    expect(() => encodeValue({ timestampValue: "not-a-date" }, on)).toThrow(
      /RFC-3339/,
    );
    expect(() => encodeValue({ stringValue: 5 }, on)).toThrow(
      /must be a string/,
    );
    expect(() =>
      encodeValue({ geoPointValue: { latitude: 999, longitude: 0 } }, on),
    ).toThrow(/latitude/);
    expect(() => encodeValue({ arrayValue: { values: "no" } }, on)).toThrow(
      /must be an array/,
    );
  });

  it("recurses into a literal array/map's children", () => {
    expect(
      encodeValue(
        { arrayValue: { values: [1, { doubleValue: 2 }] } },
        { typedValues: true },
      ),
    ).toEqual({
      arrayValue: { values: [{ integerValue: "1" }, { doubleValue: 2 }] },
    });
  });

  it("a two-key object is never a literal, even with the flag on", () => {
    expect(
      encodeValue({ stringValue: "x", other: 1 }, { typedValues: true }),
    ).toEqual({
      mapValue: {
        fields: {
          stringValue: { stringValue: "x" },
          other: { integerValue: "1" },
        },
      },
    });
  });

  it("covers every declared tag", () => {
    // Guard against a tag being added to the union but never handled.
    expect(FIRESTORE_VALUE_TAGS).toHaveLength(11);
    for (const tag of FIRESTORE_VALUE_TAGS) {
      const sample: Record<string, unknown> = {
        nullValue: null,
        booleanValue: true,
        integerValue: "1",
        doubleValue: 1.5,
        timestampValue: "2026-01-02T03:04:05Z",
        stringValue: "s",
        bytesValue: "AQID",
        referenceValue: "projects/p/databases/(default)/documents/u/1",
        geoPointValue: { latitude: 1, longitude: 2 },
        arrayValue: { values: [] },
        mapValue: { fields: {} },
      };
      const literal = { [tag]: sample[tag] };
      // Encodes without throwing, and decodes without throwing.
      const encoded = encodeValue(literal, { typedValues: true });
      expect(Object.keys(encoded), tag).toEqual([tag]);
      expect(() => decodeValue(encoded), tag).not.toThrow();
    }
  });
});
