import type { GraphQLSchemaSummary } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import { rootFields, scaffoldQuery } from "../src/canvas/graphql-introspect";

const schema: GraphQLSchemaSummary = {
  queryType: "Query",
  mutationType: "Mutation",
  types: [
    {
      name: "Query",
      kind: "OBJECT",
      fields: [
        { name: "me", args: [], type: "User" },
        { name: "user", args: ["id"], type: "User" },
      ],
    },
    {
      name: "Mutation",
      kind: "OBJECT",
      fields: [{ name: "createUser", args: ["input"], type: "User" }],
    },
    {
      name: "User",
      kind: "OBJECT",
      fields: [{ name: "name", args: [], type: "String" }],
    },
  ],
};

describe("rootFields", () => {
  it("returns query + mutation root fields tagged with their operation", () => {
    expect(rootFields(schema)).toEqual([
      { operation: "query", name: "me", args: [], type: "User" },
      { operation: "query", name: "user", args: ["id"], type: "User" },
      {
        operation: "mutation",
        name: "createUser",
        args: ["input"],
        type: "User",
      },
    ]);
  });

  it("omits an operation whose root type name isn't in the type list", () => {
    const s: GraphQLSchemaSummary = {
      queryType: "Query",
      mutationType: "Missing", // referenced but not defined → skipped
      types: [
        {
          name: "Query",
          kind: "OBJECT",
          fields: [{ name: "ping", args: [], type: "Boolean" }],
        },
      ],
    };
    expect(rootFields(s)).toEqual([
      { operation: "query", name: "ping", args: [], type: "Boolean" },
    ]);
  });

  it("returns nothing when there are no root types", () => {
    expect(rootFields({ types: [] })).toEqual([]);
  });
});

describe("scaffoldQuery", () => {
  it("scaffolds a minimal query/mutation for a root field", () => {
    expect(scaffoldQuery("query", "me")).toBe("query {\n  me\n}");
    expect(scaffoldQuery("mutation", "createUser")).toBe(
      "mutation {\n  createUser\n}",
    );
  });
});
