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
        summary:
          "A cylinder of radius r mm and height h mm. A low `segments` count makes a regular polygonal prism (segments: 6 for a hexagon/hex nut, 8 for an octagon); a high count (the default 32) reads as round. This holds in both the mesh and the exact B-rep kernel.",
      },
      {
        signature:
          "cone(r1 = 1, r2 = 0, h = 1, opts?: { center?: boolean; segments?: number }): Shape",
        summary:
          "A cone or tapered cylinder h mm tall, radius r1 mm at the base and r2 mm at the top: r2 = 0 is a sharp point, r2 equal to r1 is a plain cylinder, anything between is a truncated cone (frustum). Like cylinder, a low `segments` count makes a faceted taper. Use it for funnels, nose cones, countersinks, and tapered standoffs instead of stacking cylinders.",
      },
    ],
  },
  {
    heading:
      "2D sketches and sweeps (a sketch is a flat profile; extrude or revolve it into a solid; B-rep, the Studio auto-switches kernels)",
    entries: [
      {
        signature: "circle(r = 1, opts?: { segments?: number }): Sketch",
        summary:
          "A 2D circle of radius r mm. A low `segments` count makes a regular polygon (6 for a hexagon).",
      },
      {
        signature:
          "square(size: number | [w, h] = 1, opts?: { center?: boolean }): Sketch",
        summary:
          "A 2D square/rectangle. square(10) is 10mm on a side; square([w, h]) is rectangular. rect is an alias. Centered by default.",
      },
      {
        signature: "polygon(points: [x, y][] | number[]): Sketch",
        summary:
          "A 2D polygon from a ring of [x, y] points (mm). The ring closes back to the first point automatically.",
      },
      {
        signature: "text(content: string, opts?: { size?: number }): Sketch",
        summary:
          "A line of text as a 2D sketch in the bundled sans font, `size` mm tall (default 10). Extrude it for a raised label or subtract an extruded copy to engrave. Use this for part numbers, names, and short labels; use importSvg for arbitrary glyphs/logos.",
      },
      {
        signature: "importSvg(pathData: string): Sketch",
        summary:
          "A 2D sketch from an SVG path `d` string (M/L/H/V/C/S/Q/T/A/Z). The exact way to make a glyph, symbol, icon, or logo: emit its real outline as an SVG path and extrude it, instead of approximating a curvy shape with boolean'd circles. The Y axis is flipped so the art reads upright, and opposite-wound subpaths become holes.",
      },
      {
        signature:
          "extrude(sketch: Sketch, height: number, opts?: { twist?: number; scale?: number }): Shape",
        summary:
          "Extrude a sketch straight up by height mm into a solid. twist is total degrees over the height (0 = straight); scale tapers the top face (1 = straight walls, 0.5 = half-size top). Also a method: sketch.extrude(height, opts).",
      },
      {
        signature:
          "revolve(sketch: Sketch, opts?: { angle?: number; segments?: number }): Shape",
        summary:
          "Revolve a sketch about the Z axis into a solid of revolution; the profile's X is the radius, its Y the height (keep the profile at x >= 0). angle is the sweep in degrees (360 = a full solid). Also a method: sketch.revolve(opts).",
      },
      {
        signature:
          "sketch.union / .add / .subtract / .sub / .intersect(...others: Sketch[]): Sketch; sketch.offset(distance: number): Sketch",
        summary:
          "Combine 2D sketches before sweeping (2D booleans), or offset an outline outward (+) / inward (-) by distance mm. Example: circle(10).subtract(circle(6)) is a ring.",
      },
      {
        signature:
          "sketch.translate(x, y) / .move(x, y) / .rotate(deg) / .scale(factor) / .mirror([nx, ny]): Sketch",
        summary:
          "Position and reflect a 2D sketch before sweeping, each about the origin: translate/move by (x, y) mm, rotate by deg degrees, scale uniformly by factor, or mirror across the line through the origin with normal [nx, ny] (mirror([1, 0]) flips X, [0, 1] flips Y). Build one half of a symmetric profile and `half.union(half.mirror([1, 0]))` so the two halves line up exactly.",
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
    heading: "More solids (convex hull and explicit polyhedra; exact B-rep)",
    entries: [
      {
        signature: "hull(...shapes: Shape[]): Shape",
        summary:
          "The convex hull wrapping all of its inputs in a single solid. Hull a few spheres or cylinders to get a smooth rounded blob, a capsule, or a tapered link between two profiles.",
      },
      {
        signature: "polyhedron(points: [x, y, z][], faces: number[][]): Shape",
        summary:
          "A solid from explicit geometry: a list of [x, y, z] vertices (mm) and a list of faces, each an array of indices into that list wound counter-clockwise seen from outside. Faces may be triangles or convex n-gons. Reach for this only when a shape cannot be built from the primitives and sweeps above.",
      },
    ],
  },
  {
    heading: "Composite helpers (free functions built from the ops above)",
    entries: [
      {
        signature:
          "grid(shape: Shape, nx: number, ny: number, spacing: number | [sx, sy]): Shape",
        summary:
          "Tile a shape into a centered nx by ny grid on the XY plane (a union of copies). Prefer this over writing the copies by hand.",
      },
      {
        signature: "rectTube(outer: [ox, oy], wall: number, h: number): Shape",
        summary:
          "A hollow rectangular tube/frame: an [ox, oy] footprint with wall-thick walls, h tall, centered.",
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
        signature: "mirror(x: number | [x, y, z], y?, z?): Shape",
        summary:
          "Reflect across the plane through the origin whose normal is (x, y, z), like OpenSCAD's mirror. mirror([1,0,0]) flips X, [0,1,0] flips Y. Use it with union to build a symmetric part from one half.",
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
      "A five-pointed star extruded into a 4mm-thick badge, with the star size on a slider.",
    code: `const r = param.number("radius", { min: 10, max: 60, default: 30, step: 1 });
const inner = r * 0.4;

const pts = [];
for (let i = 0; i < 10; i++) {
  const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
  const rad = i % 2 === 0 ? r : inner;
  pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
}
return extrude(polygon(pts), 4);`,
  },
  {
    prompt:
      "A simple vase: revolve a profile so it flares from a 20mm base to a 32mm rim, 80mm tall, hollow.",
    code: `const h = param.number("height", { min: 40, max: 140, default: 80, step: 1 });
const base = 20;
const rim = 32;
const wall = 2;

// Cross-section in the XZ plane: outer wall up, across the rim, inner wall down,
// closing across the base. X is the radius, Y the height
const profile = polygon([
  [0, 0],
  [base, 0],
  [rim, h],
  [rim - wall, h],
  [base - wall, wall],
  [0, wall],
]);
return revolve(profile, { segments: 96 });`,
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
  {
    prompt:
      "A tapered standoff: a cone from a 6mm base to a 2mm top, 24mm tall, with the height on a slider.",
    code: `const h = param.number("height", { min: 10, max: 60, default: 24, step: 1 });
const base = param.number("base", { min: 2, max: 12, default: 6, step: 0.5 });
return cone(base, 2, h);`,
  },
  {
    prompt:
      "A symmetric arrow marker, 4mm thick, built from one half mirrored so the sides match exactly.",
    code: `const half = polygon([
  [0, 20], // tip
  [10, 0], // barb
  [3, 0],
  [3, -12], // tail
  [0, -12],
]);
const arrow = half.union(half.mirror([1, 0]));
return extrude(arrow, 4);`,
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
- For a polygonal prism (hex nut, octagonal post), use a cylinder whose \`segments\` equals the number of sides; do not try to build it from flat faces.
- For a recognizable glyph, symbol, letter, icon, or logo (a zodiac sign, a star, a company mark), DO NOT approximate it from boolean'd circles. Emit its exact outline as an SVG path and \`extrude(importSvg("<path d>"), thickness)\`. SVG coordinates are fine as-is (the Y flip and holes are handled). This is the single best tool for anything with a known, curvy, named shape.
- For a curvy or custom profile that is NOT a known glyph (a cam, a gear outline, a bracket), sketch it in 2D with circle/square/polygon (combine them with 2D booleans), then \`extrude\` it; for anything with rotational symmetry (a bottle, a vase, a turned knob, an O-ring), sketch the cross-section and \`revolve\` it. This is exact and far cleaner than approximating a curve with stacked or boolean'd solids.
- For a left-right symmetric profile (an arrow, a shield, a heart, a letter like A or M, most icons), sketch one half at x >= 0 and combine it with its reflection: \`half.union(half.mirror([1, 0]))\`, so the two sides line up exactly instead of being placed by hand.
- For a cone, tapered cylinder, funnel, nose cone, or countersink, use \`cone(r1, r2, h)\` (r2 = 0 for a sharp tip); do not stack or scale cylinders to fake a taper.
- Expose the key dimensions the user names as parameters (param.number / param.boolean / param.enum) with sensible min/max/default in mm, so the model is adjustable. Compute derived values from them.
- Keep it simple and correct: a model that builds and clearly matches the request beats an elaborate one that may fail. Do not add features the user did not ask for.

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
