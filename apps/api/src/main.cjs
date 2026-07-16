// CommonJS bootstrap — load the TypeScript entry through @swc/register as CommonJS.
//
// Why not `node -r @swc/register src/main.ts`? That routes the `.ts` ENTRY through node's ESM
// loader (node >=22 default for an unknown extension), and @swc's ESM path keeps `import "./env"`
// verbatim — ESM has no extensionless resolution, so it dies with
// `Cannot find module '.../src/env'` at boot. Requiring the entry from a `.cjs` file forces the
// CJS path: extensionless resolution + `import`→`require`, exactly like local dev on node 24.
//
// swc options are inline (swcrc: false) so we never depend on `.swcrc` discovery inside the
// container; they mirror the root `.swcrc` (legacyDecorator + decoratorMetadata for NestJS DI,
// module.ignoreDynamic so the node16 dynamic import() of ESM-only deps stays a real import()).
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
require("./main.ts");
