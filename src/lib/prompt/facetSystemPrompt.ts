/**
 * Grounded system prompt for Facet code generation.
 *
 * The Facet authoring API is described from a single hand-maintained spec
 * object (`API_SPEC`) so the prompt cannot drift silently from a scattered set
 * of strings. A follow-up can derive this spec from the JSDoc in
 * facet-app `src/facet/api.ts`; for now it mirrors that surface by hand
 */

interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

interface ApiEntry {
  /** Call signature as written against the API. */
  signature: string;
  /** One-line description, units included. */
  summary: string;
}

interface ApiGroup {
  heading: string;
  entries: ApiEntry[];
}

/** The Facet authoring API surface. Keep in sync with facet-app src/facet/api.ts. */
const API_SPEC: ApiGroup[] = [
  {
    heading:
      "Primitives (free functions, all dimensions in mm, centered by default)",
    entries: [
      {
        signature:
          "cube(size: number | [w, d, h] = 1, opts?: { center?: boolean }): Shape",
        summary:
          "A box. cube(10) is 10mm on a side; cube([w, d, h]) is rectangular.",
      },
      {
        signature: "box(size, opts?): Shape",
        summary: "Alias for cube.",
      },
      {
        signature: "sphere(r = 1, opts?: { segments?: number }): Shape",
        summary: "A sphere of radius r mm; higher segments is smoother.",
      },
      {
        signature:
          "cylinder(r = 1, h = 1, opts?: { center?: boolean; segments?: number }): Shape",
        summary: "A cylinder of radius r mm and height h mm.",
      },
    ],
  },
  {
    heading: "Boolean free functions (read nicely at the top level)",
    entries: [
      {
        signature: "union(...shapes: Shape[]): Shape",
        summary: "Fuse shapes together.",
      },
      {
        signature: "difference(base: Shape, ...cut: Shape[]): Shape",
        summary: "Cut the later shapes out of base.",
      },
      {
        signature: "intersection(...shapes: Shape[]): Shape",
        summary: "Keep only the overlap of the shapes.",
      },
    ],
  },
  {
    heading: "Live parameters (build sliders; read while the model runs)",
    entries: [
      {
        signature:
          "param.number(name: string, opts?: { min?: number; max?: number; step?: number; default?: number }): number",
        summary:
          "Register a numeric parameter and return its current value, in mm or the model's own unit.",
      },
      {
        signature:
          "param.boolean(name: string, opts?: { default?: boolean }): boolean",
        summary:
          "Register a boolean parameter (renders a checkbox) and return its current value. Prefer this over a 0/1 slider for toggles.",
      },
      {
        signature:
          "param.enum(name: string, opts: { options: string[]; default?: string }): string",
        summary:
          "Register a choice parameter (renders a dropdown) and return the selected option string. param.select is an alias. Prefer this over an index slider for a fixed set of choices.",
      },
    ],
  },
  {
    heading:
      "Shape methods (chainable; transforms in mm and degrees; booleans take one or more Shapes)",
    entries: [
      {
        signature: "translate(x: number | [x, y, z], y?, z?): Shape",
        summary: "Move by (x, y, z) mm, or by a vector.",
      },
      { signature: "move(x, y?, z?): Shape", summary: "Alias for translate." },
      {
        signature: "rotate(x: number | [x, y, z], y?, z?): Shape",
        summary: "Rotate in degrees about X, Y, Z (applied in that order).",
      },
      {
        signature: "scale(x: number | [x, y, z], y?, z?): Shape",
        summary: "Scale; a single number scales uniformly.",
      },
      {
        signature: "union(...others: Shape[]): Shape",
        summary: "Fuse this shape with others.",
      },
      {
        signature: "add(...others: Shape[]): Shape",
        summary: "Alias for union.",
      },
      {
        signature: "subtract(...others: Shape[]): Shape",
        summary: "Cut the others out of this shape.",
      },
      {
        signature: "sub(...others: Shape[]): Shape",
        summary: "Alias for subtract.",
      },
      {
        signature: "intersect(...others: Shape[]): Shape",
        summary: "Keep only the overlap with others.",
      },
      {
        signature: "fillet(radius: number): Shape",
        summary:
          "Round every edge by radius mm. Exact geometry (B-rep); the Studio auto-switches kernels.",
      },
      {
        signature: "chamfer(size: number): Shape",
        summary:
          "Bevel every edge by size mm. Exact geometry (B-rep); the Studio auto-switches kernels.",
      },
      {
        signature: "shell(thickness: number): Shape",
        summary:
          "Hollow the solid to a wall of thickness mm, opening the top +Z face. Exact geometry (B-rep); the Studio auto-switches kernels.",
      },
    ],
  },
];

/** Curated prompt -> code examples drawn from facet-app src/examples.ts. */
const FEW_SHOT: { prompt: string; code: string }[] = [
  {
    prompt:
      "A 30mm block with an optional through-hole toggle and a square-or-hex profile chosen from a dropdown.",
    code: `const hollow = param.boolean("hollow", { default: true });
const profile = param.enum("profile", { options: ["square", "hex"], default: "square" });

const size = 30;
let base =
  profile === "hex"
    ? cylinder(size / 2, size, { segments: 6 })
    : cube(size);
if (hollow) {
  base = base.subtract(cylinder(3, size + 2, { segments: 48 }));
}
return base;`,
  },
  {
    prompt:
      "A 50 x 34 x 12 mm plate with a 6mm-radius hole through it, all driven by sliders.",
    code: `const w = param.number("width", { min: 20, max: 90, default: 50, step: 1 });
const d = param.number("depth", { min: 20, max: 90, default: 34, step: 1 });
const h = param.number("height", { min: 4, max: 40, default: 12, step: 1 });
const r = param.number("hole", { min: 0, max: 14, default: 6, step: 0.5 });

let plate = cube([w, d, h]);
if (r > 0) {
  plate = plate.subtract(cylinder(r, h + 2, { segments: 48 }));
}
return plate;`,
  },
  {
    prompt:
      "An L-bracket: a 40mm-wide base plate and an upright wall, 5mm thick, with two bolt holes through the base.",
    code: `const t = 5;   // thickness
const w = 40;  // width

const base = cube([w, 40, t], { center: false });
const wall = cube([w, t, 30], { center: false });
let part = base.union(wall);

const hole = cylinder(3.2, t * 4, { segments: 32 });
part = part.subtract(
  hole.translate(12, 20, t / 2),
  hole.translate(28, 20, t / 2),
);
return part;`,
  },
  {
    prompt:
      "A pipe flange: a 30mm-radius disc 6mm thick, bored out to 14mm, with six bolt holes on a 22mm circle.",
    code: `const flange = cylinder(30, 6, { segments: 72 });
const bore = cylinder(14, 20, { segments: 72 });
let part = flange.subtract(bore);

const bolts = 6;
for (let i = 0; i < bolts; i++) {
  const a = (i / bolts) * Math.PI * 2;
  const hole = cylinder(3, 20, { segments: 24 })
    .translate(Math.cos(a) * 22, Math.sin(a) * 22, 0);
  part = part.subtract(hole);
}
return part;`,
  },
];

const renderApiSpec = (): string =>
  API_SPEC.map(
    (group) =>
      `${group.heading}\n${group.entries
        .map((entry) => `- ${entry.signature}\n    ${entry.summary}`)
        .join("\n")}`,
  ).join("\n\n");

const renderFewShot = (): string =>
  FEW_SHOT.map(
    (example) => `Prompt: ${example.prompt}\n\`\`\`ts\n${example.code}\n\`\`\``,
  ).join("\n\n");

/**
 * Build the system prompt the model is grounded on. It states the task, the
 * output contract (one fenced ts block, no prose), the full Facet API surface,
 * and a few curated examples
 */
export const buildSystemPrompt = (): string =>
  `You are a parametric CAD assistant for Facet. Turn the user's request into a Facet model written in TypeScript.

Output contract (strict):
- Reply with exactly one fenced code block tagged \`\`\`ts and nothing else. No prose, no explanation, no extra code blocks.
- The code runs in a sandbox where the Facet authoring API below is already in scope. Do not import anything.
- The last statement must \`return\` the final Shape.
- All lengths are in millimeters (mm); all angles are in degrees.
- Use only the API documented below. Do not invent functions or methods.
- fillet, chamfer and shell are exact-geometry (B-rep) operations; the Studio switches to the exact kernel automatically when they are used.

Facet API:
${renderApiSpec()}

Examples:
${renderFewShot()}`;

/**
 * Build the repair turns for a follow-up attempt. The route prepends the
 * original user prompt; these add the model's prior code and the kernel error,
 * ending on a user turn that asks for a corrected single fenced ts block
 */
export const buildRepairMessages = (
  code: string,
  errorText: string,
): PromptMessage[] => [
  { role: "assistant", content: `\`\`\`ts\n${code}\n\`\`\`` },
  {
    role: "user",
    content: `Running that code threw the following error:\n\n${errorText}\n\nFix the problem and reply with a single corrected fenced ts code block, no prose.`,
  },
];
