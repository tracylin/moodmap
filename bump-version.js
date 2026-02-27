// bump-version.js — run before deploy, or add to package.json build script
// Usage: node bump-version.js
import { writeFileSync } from "fs";
writeFileSync(
  "public/version.json",
  JSON.stringify({ v: new Date().toISOString() }) + "\n"
);
console.log("version.json updated:", new Date().toISOString());