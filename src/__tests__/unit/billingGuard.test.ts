import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import * as schema from "lib/db/schema";

/**
 * Billing guard (R1/R8 of the fleet AI billing cutover).
 *
 * Managed AI is billed only by the Synapse gateway against Facet's Aether app:
 * the gateway converts real cost to credits and debits the pooled balance. Facet
 * must never grow a second, local billing path again, so this fails the build if
 * a local ledger, a cost-to-credit conversion, a margin multiplier, or a billing
 * rate table reappears in the source. The per-model token rates may only feed
 * the daily spend breaker's cost estimate (the backstop), so they stay confined
 * to the config and the Synapse client
 */

const SRC = join(import.meta.dir, "..", "..");
const SELF = relative(SRC, import.meta.path);

/** Every TypeScript source file under src, except generated output and this guard */
const sourceFiles = (): { path: string; text: string }[] => {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(SRC, full);
      if (rel === "generated") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && rel !== SELF)
        out.push({ path: rel, text: readFileSync(full, "utf-8") });
    }
  };
  walk(SRC);
  return out;
};

const filesMatching = (pattern: RegExp) =>
  sourceFiles()
    .filter((f) => pattern.test(f.text))
    .map((f) => f.path);

describe("billing guard", () => {
  test("scans the real source tree", () => {
    expect(sourceFiles().length).toBeGreaterThan(20);
  });

  test("no local credit ledger remains", () => {
    expect(
      filesMatching(
        /credit_ledger|creditLedger|creditStore|CreditStore|getMonthlyUsage|recordSpend/,
      ),
    ).toEqual([]);
    expect(Object.keys(schema)).not.toContain("creditLedgerTable");
  });

  test("no local cost-to-credit conversion or margin multiplier remains", () => {
    expect(
      filesMatching(
        /creditsFromCostCents|DEFAULT_CREDIT_COGS_MARKUP|CENTS_PER_CREDIT|markup/i,
      ),
    ).toEqual([]);
  });

  test("no local credit cap or allowance remains (Aether owns the balance)", () => {
    expect(
      filesMatching(
        /included_credits|entitlementCap|CapResolver|FREE_MONTHLY_CREDITS|freeMonthlyCredits/,
      ),
    ).toEqual([]);
  });

  test("no shared managed key remains (managed traffic is product-scoped)", () => {
    expect(filesMatching(/SYNAPSE_API_KEY|synapseApiKey|serverApiKey/)).toEqual(
      [],
    );
  });

  test("model token rates stay confined to the breaker estimate path", () => {
    expect(filesMatching(/CentsPerMTok/).sort()).toEqual(
      [
        join("lib", "config", "ai.config.test.ts"),
        join("lib", "config", "ai.config.ts"),
        join("lib", "synapse", "client.test.ts"),
        join("lib", "synapse", "client.ts"),
      ].sort(),
    );
  });
});
