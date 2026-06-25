import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

// This test exists to prove the swc transform under vitest emits decorator
// metadata. If it doesn't, Nest cannot resolve the constructor-injected
// dependency and fails with "Nest can't resolve dependencies of Consumer (?)".
// A test that merely compiles a module would NOT catch this — the gate is that
// a constructor-injected provider is actually resolved.

@Injectable()
class Dependency {
  value(): string {
    return "injected-ok";
  }
}

@Injectable()
class Consumer {
  // No @Inject() token — relies purely on emitted parameter-type metadata.
  constructor(private readonly dep: Dependency) {}

  run(): string {
    return this.dep.value();
  }
}

describe("NestJS DI wiring (swc decorator metadata)", () => {
  it("resolves a constructor-injected provider via type metadata", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Dependency, Consumer],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.run()).toBe("injected-ok");
  });
});
