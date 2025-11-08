import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");

const target = process.argv[2] ?? "chrome";
const distDir = path.join(projectRoot, target === "firefox" ? "dist-firefox" : "dist");

async function main() {
  await mkdir(distDir, { recursive: true });
  await cp(publicDir, distDir, { recursive: true });

  if (target === "firefox") {
    const manifestPath = path.join(distDir, "manifest.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw);

    // Convert to a Firefox-friendly background script and MV2-style permissions
    manifest.manifest_version = 2;
    if (manifest.background && manifest.background.service_worker) {
      delete manifest.background.service_worker;
    }
    if (manifest.background && manifest.background.type) {
      delete manifest.background.type;
    }
    // Ensure background.scripts exists
    if (!manifest.background || !manifest.background.scripts) {
      manifest.background = { scripts: ["background.js"] };
    }

    // Move host_permissions into permissions for MV2
    const hostPerms = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
    delete manifest.host_permissions;
    const basePerms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    manifest.permissions = Array.from(new Set([...basePerms, ...hostPerms]));

    // Add browser specific settings for Gecko
    manifest.browser_specific_settings = {
      gecko: {
        id: "rbdb-extension@local",
        strict_min_version: "109.0"
      }
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

main().catch((error) => {
  console.error("Failed to copy static assets", error);
  process.exit(1);
});
