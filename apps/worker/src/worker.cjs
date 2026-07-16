// CommonJS bootstrap — see apps/api/src/main.cjs for the full rationale. In short: running the
// `.ts` entry via `node -r @swc/register src/worker.ts` routes it through node's ESM loader
// (node >=22), where extensionless relative imports fail; requiring the entry from a `.cjs` file
// forces the CJS path. swc options are inline (swcrc: false) so we don't depend on `.swcrc`
// discovery inside the container.
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
require("./worker.ts");
