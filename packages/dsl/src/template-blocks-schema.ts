/**
 * The SAVE-GATE half of template blocks: the zod validators the API runs when a Template is
 * written. Split out of `./template-blocks` (#926) purely so the RENDERER half stays zod-free.
 *
 * WHY THIS FILE EXISTS. `./template-blocks` exports `renderEmailHtml`, which the deterministic
 * Temporal workflow bundle needs (the `sendEmail` node handler renders a template's blocks against
 * ctx in workflow code). `@naary/dsl` is CJS with no `"exports"` map, so nothing tree-shakes and a
 * module's own `require`s are its transitive cost: one `import { z } from "zod"` next to the
 * renderer put ALL of zod — 691 KB of module code, plus its share of the inline source map — into
 * the bundle every worker loads at boot and every replay re-evaluates. Same lesson as #910:
 * the module boundary IS the dependency boundary.
 *
 * THE RULE THAT KEEPS IT WORKING: this file may import from `./template-blocks`, NEVER the reverse.
 * A convenience `export * from "./template-blocks-schema"` over there would re-`require` zod and
 * silently undo the whole change — with no error and no failing build. The type import below is
 * erased at compile time, so it costs nothing. `apps/worker/test/workflow-bundle.spec.ts` asserts
 * zod's absence from the REAL bundle, which is the alarm if this edge is ever reversed.
 *
 * Both schemas remain exported from the `@naary/dsl` barrel, so every consumer outside this
 * package (`apps/api`, `apps/web`) is unchanged.
 */
import { z } from "zod";
import { isPollutingKey } from "./mcp-args";
import type { TemplateBlock } from "./template-blocks";

/** Runtime validator for a block — the API validates `Template.blocks` on save against this, so a
 *  stored template can never carry a malformed block the renderer would choke on. */
export const templateBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string(),
  }),
  z.object({ id: z.string(), type: z.literal("text"), html: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("image"),
    src: z.string(),
    alt: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("button"),
    label: z.string(),
    href: z.string(),
  }),
  z.object({ id: z.string(), type: z.literal("divider") }),
  z.object({ id: z.string(), type: z.literal("spacer"), size: z.number() }),
  z.object({
    id: z.string(),
    type: z.literal("field"),
    /**
     * #761: same guard as a formTrigger's inline field key, and for the same reason — a form template's
     * `field` blocks BECOME the submitted field set (`fieldsFromBlocks` in apps/api), so a key here
     * reaches exactly the code path where writing to `__proto__` silently discards the value. Guarding
     * only the inline `fields` would have left the template route open.
     */
    key: z.string().refine((k) => !isPollutingKey(k), {
      message:
        "key must not be __proto__, constructor or prototype — a value written to one of those names is silently discarded and never reaches the workflow",
    }),
    label: z.string(),
    fieldType: z.enum(["text", "textarea", "number", "email", "select"]),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
  }),
]);

/** `Template.blocks` — an ordered array of validated blocks. */
export const templateBlocksSchema = z.array(templateBlockSchema);

/**
 * Compile-time tie back to the renderer's union: what the save gate accepts must be exactly what
 * `renderEmailHtml` knows how to render. Without this the two halves could drift silently now that
 * they live in different files — a block shape added to `TemplateBlock` but not to the schema would
 * be rejected on save; one added to the schema but not the union would reach the renderer's
 * exhaustive `switch` as `undefined` markup.
 */
type Assert<T extends true> = T;
type _SchemaAcceptsOnlyRenderableBlocks = Assert<
  z.infer<typeof templateBlockSchema> extends TemplateBlock ? true : false
>;
type _RendererHandlesEverySavedBlock = Assert<
  TemplateBlock extends z.infer<typeof templateBlockSchema> ? true : false
>;
