import { readFileSync, writeFileSync } from "node:fs";
import { darkRootTokens } from "../../tests/lib/dark-root-tokens";

const [src, out] = process.argv.slice(2);
const tokens = darkRootTokens(readFileSync(src, "utf8"));
writeFileSync(out, JSON.stringify(tokens, null, 2) + "\n");
console.log(`${Object.keys(tokens).length} tokens`);
