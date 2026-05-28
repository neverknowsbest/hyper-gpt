// Rasterize frontend/public/icon.svg into the PNG sizes PWA install needs.
// Run: bun frontend/scripts/gen-icons.ts
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pub = join(import.meta.dir, "..", "public");
const svg = readFileSync(join(pub, "icon.svg"));

const targets = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon.png" }, // iOS home screen
];

for (const { size, name } of targets) {
  await sharp(svg).resize(size, size).png().toFile(join(pub, name));
  console.log("wrote", name);
}
