/**
 * The Firestore value codec — plain JSON in, typed Firestore wire values out, and back.
 *
 * This is the whole reason Firestore is a NODE and not a declarative catalog entry
 * (`buildIntegrationRequest` can only `setPath` static paths). Firestore's REST API wraps
 * every value in its RUNTIME type:
 *
 *     { "fields": { "name": { "stringValue": "ada" }, "count": { "integerValue": "5" } } }
 *
 * The author never sees that. They write `{ name: "ada", count: 5 }` and read the same
 * thing back.
 *
 * PURE — no I/O, no clock, no randomness. Exhaustively unit-testable with no network.
 */

/** A Firestore `Value` — exactly one of the eleven type tags is present. */
export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { geoPointValue: { latitude?: number; longitude?: number } }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

/** The eleven wire tags, in the order the Firestore `Value` proto declares them. */
export const FIRESTORE_VALUE_TAGS = [
  "nullValue",
  "booleanValue",
  "integerValue",
  "doubleValue",
  "timestampValue",
  "stringValue",
  "bytesValue",
  "referenceValue",
  "geoPointValue",
  "arrayValue",
  "mapValue",
] as const;

const TAG_SET: ReadonlySet<string> = new Set<string>(FIRESTORE_VALUE_TAGS);

/** A value the codec refuses to convert, naming the offending path (e.g. `$.items[2]`). */
export class FirestoreValueError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = "FirestoreValueError";
  }
}

export interface EncodeOptions {
  /**
   * Interpret a single-key object whose key is one of {@link FIRESTORE_VALUE_TAGS} as a
   * LITERAL Firestore value rather than encoding it as a map — the escape hatch for the
   * types plain JSON cannot express: a `doubleValue` holding a whole number, a
   * `geoPointValue`, a `referenceValue`, an explicit `timestampValue`.
   *
   * DEFAULT OFF, and deliberately so: `{"stringValue": "x"}` is perfectly ordinary JSON
   * that anyone who has ever dumped a Firestore export into a document field will really
   * have, and silently reinterpreting it would corrupt their data. Off, that object is
   * just a map and round-trips untouched. On, the author has opted into the collision.
   */
  typedValues?: boolean;
}

/** Assign `key` as an OWN data property — never through the `__proto__` setter (#591). */
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Is this object the literal wire form `{ <tag>: … }` (exactly one key, a known tag)? */
function isTypedLiteral(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && TAG_SET.has(keys[0] as string);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Encode one plain JS value as a Firestore `Value`.
 *
 * The `number` rule is the one that silently writes the wrong type into someone's
 * database if you get it wrong, so it is stated exactly:
 *
 *   - `Number.isSafeInteger(n)` ⇒ `integerValue` (the wire form is a decimal STRING —
 *     that is the classic Firestore trap; the JSON field is a string, not a number).
 *   - any other finite number ⇒ `doubleValue`.
 *   - `NaN` / `±Infinity` ⇒ rejected. They have no JSON representation, so there is no
 *     honest thing to write.
 *
 * `Number.isSafeInteger`, NOT `Number.isInteger`: `Number.isInteger(1e21)` is `true`, and
 * `String(1e21)` is `"1e+21"` — not a decimal string, so Firestore rejects the write. The
 * safe-integer gate is exactly the range in which `String(n)` is guaranteed to produce
 * plain digits AND in which the value survives the round trip back into a JS number.
 *
 * CONSEQUENCE, and it is unavoidable: JSON cannot distinguish `1` from `1.0`, so a whole
 * number is written as an INTEGER. Use `typedValues` + `{"doubleValue": 1}` to force a
 * double.
 */
export function encodeValue(
  value: unknown,
  opts: EncodeOptions = {},
  path = "$",
): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };

  const t = typeof value;
  if (t === "boolean") return { booleanValue: value as boolean };
  if (t === "string") return { stringValue: value as string };

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new FirestoreValueError(
        `Cannot write ${String(n)} to Firestore — it has no JSON representation`,
        path,
      );
    }
    // Safe integers only — see the doc comment. Outside that range String(n) can produce
    // exponent notation, which Firestore rejects outright.
    if (Number.isSafeInteger(n)) return { integerValue: String(n) };
    return { doubleValue: n };
  }

  if (t === "bigint") return { integerValue: (value as bigint).toString() };

  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new FirestoreValueError("Cannot write an Invalid Date", path);
    }
    return { timestampValue: value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    return { bytesValue: Buffer.from(value).toString("base64") };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        // JSON.stringify turns a hole/undefined in an array into null; match it, so what
        // the author sees in the canvas is what lands in the document.
        values: value.map((item, i) =>
          encodeValue(item, opts, `${path}[${i}]`),
        ),
      },
    };
  }

  if (isPlainObject(value)) {
    if (opts.typedValues && isTypedLiteral(value)) {
      return normalizeLiteral(value as unknown as FirestoreValue, opts, path);
    }
    return { mapValue: { fields: encodeFields(value, opts, path) } };
  }

  throw new FirestoreValueError(
    `Cannot write a value of type ${t === "object" ? Object.prototype.toString.call(value) : t}`,
    path,
  );
}

/**
 * Validate + normalize an author-supplied literal wire value (`typedValues` mode). The tag
 * is trusted, the CONTENTS are not: an `arrayValue`/`mapValue` literal has its children
 * re-encoded, so a malformed nested value is caught here rather than by Firestore.
 */
function normalizeLiteral(
  literal: FirestoreValue,
  opts: EncodeOptions,
  path: string,
): FirestoreValue {
  const tag = Object.keys(literal)[0] as (typeof FIRESTORE_VALUE_TAGS)[number];
  const raw = (literal as Record<string, unknown>)[tag];

  switch (tag) {
    case "nullValue":
      return { nullValue: null };
    case "booleanValue":
      return { booleanValue: Boolean(raw) };
    case "integerValue": {
      // Accept a number for ergonomics, but emit the wire form: a decimal string.
      if (typeof raw === "number") {
        if (!Number.isSafeInteger(raw)) {
          throw new FirestoreValueError(
            `integerValue ${raw} is not a safe integer — pass it as a decimal string`,
            path,
          );
        }
        return { integerValue: String(raw) };
      }
      if (typeof raw === "bigint") return { integerValue: raw.toString() };
      if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
        return { integerValue: raw };
      }
      throw new FirestoreValueError(
        "integerValue must be a decimal string or a safe integer",
        path,
      );
    }
    case "doubleValue": {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new FirestoreValueError(
          "doubleValue must be a finite number",
          path,
        );
      }
      return { doubleValue: n };
    }
    case "timestampValue": {
      if (raw instanceof Date) return { timestampValue: raw.toISOString() };
      if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
        throw new FirestoreValueError(
          "timestampValue must be an RFC-3339 timestamp string",
          path,
        );
      }
      return { timestampValue: raw };
    }
    case "stringValue":
    case "bytesValue":
    case "referenceValue": {
      if (typeof raw !== "string") {
        throw new FirestoreValueError(`${tag} must be a string`, path);
      }
      return { [tag]: raw } as FirestoreValue;
    }
    case "geoPointValue": {
      const g = raw as { latitude?: unknown; longitude?: unknown } | null;
      const lat = Number(g?.latitude ?? 0);
      const lng = Number(g?.longitude ?? 0);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new FirestoreValueError(
          "geoPointValue.latitude must be -90..90",
          path,
        );
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new FirestoreValueError(
          "geoPointValue.longitude must be -180..180",
          path,
        );
      }
      return { geoPointValue: { latitude: lat, longitude: lng } };
    }
    case "arrayValue": {
      const values = (raw as { values?: unknown } | null)?.values;
      if (values !== undefined && !Array.isArray(values)) {
        throw new FirestoreValueError(
          "arrayValue.values must be an array",
          path,
        );
      }
      return {
        arrayValue: {
          values: ((values as unknown[]) ?? []).map((v, i) =>
            encodeValue(v, opts, `${path}[${i}]`),
          ),
        },
      };
    }
    case "mapValue": {
      const fields = (raw as { fields?: unknown } | null)?.fields;
      if (fields !== undefined && !isPlainObject(fields)) {
        throw new FirestoreValueError(
          "mapValue.fields must be an object",
          path,
        );
      }
      return {
        mapValue: {
          fields: encodeFields(
            (fields as Record<string, unknown>) ?? {},
            opts,
            path,
          ),
        },
      };
    }
  }
}

/**
 * Encode a plain object as a Firestore `fields` map.
 *
 * `undefined`-valued keys are DROPPED rather than written as null — the same thing
 * `JSON.stringify` does, which is the mental model an author already has for what a node
 * output contains.
 */
export function encodeFields(
  obj: Record<string, unknown>,
  opts: EncodeOptions = {},
  path = "$",
): Record<string, FirestoreValue> {
  const out: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    setOwn(
      out as unknown as Record<string, unknown>,
      key,
      encodeValue(value, opts, `${path}.${key}`),
    );
  }
  return out;
}

/**
 * Decode a Firestore `Value` back to plain JSON.
 *
 * The inverse of {@link encodeValue} on its whole image, so with `typedValues` off,
 * `decodeValue(encodeValue(v))` deep-equals `v` for every value expressible in plain JSON.
 *
 * The types plain JSON has no slot for become their natural readable form — a timestamp is
 * its RFC-3339 string, bytes are base64, a reference is its document path, a geo point is
 * `{latitude, longitude}`. Those decodings are deliberately LOSSY in the other direction
 * (re-encoding one yields a string/map, not the original tag): the alternative is showing
 * the author `{"timestampValue": …}`, which is exactly the wire noise this node exists to
 * hide. Use `typedValues` when you need to write those types back.
 */
export function decodeValue(value: FirestoreValue): unknown {
  const v = value as Record<string, unknown>;

  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return Boolean(v.booleanValue);
  if ("stringValue" in v) return String(v.stringValue ?? "");

  if ("integerValue" in v) {
    // The wire form is a STRING. Return a number when the value survives that round trip,
    // and the decimal string when it does not — a >2^53 id silently losing precision is
    // far worse than a field arriving as a string.
    const raw = v.integerValue;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isSafeInteger(n) ? n : String(raw);
  }

  if ("doubleValue" in v) {
    // proto3 JSON encodes NaN/Infinity as strings; neither is JSON-representable, so pass
    // the string through rather than inventing a number.
    const raw = v.doubleValue;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : String(raw);
  }

  if ("timestampValue" in v) return String(v.timestampValue ?? "");
  if ("bytesValue" in v) return String(v.bytesValue ?? "");
  if ("referenceValue" in v) return String(v.referenceValue ?? "");

  if ("geoPointValue" in v) {
    // proto3 JSON OMITS zero-valued fields, so the geo point (0, 0) arrives as `{}`.
    const g = (v.geoPointValue ?? {}) as {
      latitude?: number;
      longitude?: number;
    };
    return { latitude: g.latitude ?? 0, longitude: g.longitude ?? 0 };
  }

  if ("arrayValue" in v) {
    const values = ((v.arrayValue ?? {}) as { values?: FirestoreValue[] })
      .values;
    return (values ?? []).map(decodeValue);
  }

  if ("mapValue" in v) {
    const fields = (
      (v.mapValue ?? {}) as { fields?: Record<string, FirestoreValue> }
    ).fields;
    return decodeFields(fields ?? {});
  }

  throw new FirestoreValueError(
    `Unrecognized Firestore value tag: ${Object.keys(v).join(",") || "<empty>"}`,
    "$",
  );
}

/**
 * Decode a Firestore `fields` map to a plain object.
 *
 * Keys come from the DATABASE, so they are untrusted. Firestore permits a field literally
 * named `__proto__`, and a plain `out[key] = …` would run the prototype setter (#591).
 * Every key is installed with `Object.defineProperty`, which makes it an ordinary own
 * property — so the data survives intact AND nothing is polluted. Nothing is dropped.
 */
export function decodeFields(
  fields: Record<string, FirestoreValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    setOwn(out, key, decodeValue(value));
  }
  return out;
}
