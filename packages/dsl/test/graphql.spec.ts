import { describe, expect, it } from "vitest";
import { resolveGraphQL } from "../src/graphql";
import type { GraphQLNodeConfig } from "../src/types";

const ctx = {
  trigger: { userId: "u-7" },
  agent: { output: { org: "acme" } },
};

describe("resolveGraphQL", () => {
  it("passes static config through, defaulting variables/headers to {}", () => {
    const config: GraphQLNodeConfig = {
      url: "https://api.example.com/graphql",
      query: "{ me { id } }",
      costUsd: 0.002,
    };
    expect(resolveGraphQL(config, ctx)).toEqual({
      url: "https://api.example.com/graphql",
      query: "{ me { id } }",
      variables: {},
      headers: {},
      failOnErrors: undefined,
      timeoutMs: undefined,
      costUsd: 0.002,
    });
  });

  it("overrides a value at a dotted binding path from upstream (variables.id)", () => {
    const config: GraphQLNodeConfig = {
      url: "https://api.example.com/graphql",
      query: "query($id:ID!){ user(id:$id){ name } }",
      variables: { id: "static", limit: 10 },
      argumentBindings: {
        "variables.id": { from: "trigger", path: "userId" },
      },
    };
    const out = resolveGraphQL(config, ctx);
    expect(out.variables).toEqual({ id: "u-7", limit: 10 });
  });

  it("leaves a `{{ $secrets.NAME }}` header token literal (resolved in-activity)", () => {
    const config: GraphQLNodeConfig = {
      url: "https://api.example.com/graphql",
      query: "{ x }",
      headers: { Authorization: "Bearer {{ $secrets.TOKEN }}" },
    };
    expect(resolveGraphQL(config, ctx).headers).toEqual({
      Authorization: "Bearer {{ $secrets.TOKEN }}",
    });
  });

  it("deep-clones variables so a binding can't mutate the source config", () => {
    const config: GraphQLNodeConfig = {
      url: "https://x/graphql",
      query: "{ x }",
      variables: { nested: { id: "orig" } },
      argumentBindings: {
        "variables.nested.id": { from: "agent", path: "output.org" },
      },
    };
    const out = resolveGraphQL(config, ctx);
    expect(out.variables).toEqual({ nested: { id: "acme" } });
    // the original config object is untouched
    expect(config.variables).toEqual({ nested: { id: "orig" } });
  });
});
