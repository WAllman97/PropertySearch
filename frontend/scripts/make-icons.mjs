// Render resources/icon.svg into the iOS app icon and splash screen.
//   npm run app:icons
// Writes into the Xcode asset catalog and public/; commit what it makes.
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "ios/App/App/Assets.xcassets");
const svg = readFileSync(path.join(root, "resources/icon.svg"));

const GREEN = "#223a33";
const CREAM = "#f8f6f2";

// App icon: one 1024x1024 PNG, no transparency (App Store rejects alpha).
const icon = await sharp(svg, { density: 300 })
  .resize(1024, 1024)
  .flatten({ background: GREEN })
  .removeAlpha()
  .png()
  .toBuffer();
writeFileSync(path.join(assets, "AppIcon.appiconset/AppIcon-512@2x.png"), icon);

// Splash: cream background with the rounded icon in the middle. The launch
// storyboard aspect-fills this square, so the logo stays well inside the centre.
const size = 2732;
const logo = 520;
const mask = Buffer.from(
  `<svg width="${logo}" height="${logo}"><rect width="${logo}" height="${logo}" rx="116" ry="116"/></svg>`
);
const rounded = await sharp(icon)
  .resize(logo, logo)
  .composite([{ input: mask, blend: "dest-in" }])
  .png()
  .toBuffer();
const splash = await sharp({ create: { width: size, height: size, channels: 3, background: CREAM } })
  .composite([{ input: rounded, left: (size - logo) / 2, top: (size - logo) / 2 }])
  .removeAlpha()
  .png()
  .toBuffer();
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  writeFileSync(path.join(assets, "Splash.imageset", name), splash);
}

// Website: browser tab icon and the icon for "Add to Home Screen".
const publicDir = path.join(root, "public");
mkdirSync(publicDir, { recursive: true });
writeFileSync(path.join(publicDir, "favicon.svg"), svg);
await sharp(icon).resize(180, 180).png().toFile(path.join(publicDir, "apple-touch-icon.png"));

console.log("App icon, splash and web icons written");
