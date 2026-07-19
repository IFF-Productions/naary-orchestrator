// CommonJS bootstrap for the OpenAPI emitter — same pattern as main.cjs.
//
// `node -r @swc/register src/emit-openapi.ts` routes the `.ts` entry through node's
// ESM loader (node >=22 default for an unknown extension), which bypasses @swc's
// require hook — decorators aren't transformed and extensionless imports die. Requiring
// the entry from a `.cjs` file forces the CJS path: swc transforms it (legacyDecorator +
// decoratorMetadata for Nest's route scan), extensionless `import`→`require` resolves.
//
// swc options are inline (swcrc: false) so we don't depend on `.swcrc` discovery; they
// mirror the root `.swcrc`.
require("@swc/register")({
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: "es2021",
    keepClassNames: true,
  },
  module: { type: "commonjs", ignoreDynamic: true },
  swcrc: false,
});
require("./emit-openapi.ts");
