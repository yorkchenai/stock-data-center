// Test/verification bridge. Input and output are canonical daily JSON arrays.
import { readFileSync } from "node:fs";
import { calculateIndicators } from "../web/engine.mjs";
process.stdout.write(
  JSON.stringify(calculateIndicators(JSON.parse(readFileSync(0, "utf8")))),
);
