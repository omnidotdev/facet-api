import { describe, expect, test } from "bun:test";

import { buildRepairMessages, buildSystemPrompt } from "./facetSystemPrompt";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  test("instructs exactly one fenced ts code block and no prose", () => {
    expect(prompt).toMatch(/one fenced/i);
    expect(prompt).toContain("```ts");
    expect(prompt).toMatch(/no prose/i);
  });

  test("documents every current free function", () => {
    for (const fn of [
      "cube",
      "box",
      "sphere",
      "cylinder",
      "union",
      "difference",
      "intersection",
      "param",
    ]) {
      expect(prompt).toContain(fn);
    }
  });

  test("documents every current Shape method", () => {
    for (const method of [
      "translate",
      "move",
      "rotate",
      "scale",
      "mirror",
      "add",
      "subtract",
      "sub",
      "intersect",
      "fillet",
      "chamfer",
      "shell",
    ]) {
      expect(prompt).toContain(method);
    }
  });

  test("documents the 2D sketch and sweep API", () => {
    for (const fn of [
      "circle",
      "square",
      "polygon",
      "importSvg",
      "extrude",
      "revolve",
      "offset",
    ]) {
      expect(prompt).toContain(fn);
    }
    // the sketch -> solid concept is stated, not just the names
    expect(prompt).toMatch(/revolve/i);
    expect(prompt).toMatch(/extrude/i);
  });

  test("states units: millimeters and degrees", () => {
    expect(prompt).toMatch(/mm|millimet/i);
    expect(prompt).toMatch(/degree/i);
  });

  test("flags fillet, chamfer and shell as exact-geometry (B-rep) ops", () => {
    expect(prompt).toMatch(/b-rep|exact geometry|exact-geometry/i);
    expect(prompt).toContain("fillet");
    expect(prompt).toContain("chamfer");
    expect(prompt).toContain("shell");
  });

  test("embeds at least two few-shot examples drawn from the example models", () => {
    // few-shot code uses the authoring API and the return convention
    expect(prompt).toContain("return ");
    const fenced = prompt.match(/```ts[\s\S]*?```/g) ?? [];
    // one block documents nothing by itself, examples add more
    expect(fenced.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildRepairMessages", () => {
  test("carries the prior code and the error, ending on a user turn", () => {
    const messages = buildRepairMessages(
      "const x = cube(10);\nreturn x;",
      "KernelError: unknown op 'spere'",
    );

    expect(messages.length).toBeGreaterThanOrEqual(2);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("cube(10)");

    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("KernelError: unknown op 'spere'");
    expect(last.content).toMatch(/fenced ts|single.*block/i);
  });
});
