// Contrôles de cohérence du projet, sans dépendance : syntaxe de chaque script,
// fichiers déclarés par le manifeste, version identique partout, suites de
// tests toutes enregistrées et dépendance lamejs inchangée.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = new URL("../", import.meta.url);
const root = new URL("../../", import.meta.url);
const read = (base, path) => readFile(new URL(path, base), "utf8");
const exists = (path) => stat(new URL(path, extension)).then(() => true, () => false);

// Syntaxe de chaque script de l'extension et des tests (lamejs exclu).
const scripts = [
  ...(await readdir(extension)).filter((name) => name.endsWith(".js")),
  ...(await readdir(new URL("tests/", extension))).filter((name) => name.endsWith(".mjs")).map((name) => `tests/${name}`)
];
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(script, extension))], { encoding: "utf8" });
  assert.equal(result.status, 0, `Syntaxe invalide dans ${script} :\n${result.stderr}`);
}

// Tout fichier référencé par le manifeste existe.
const manifest = JSON.parse(await read(extension, "manifest.json"));
const referenced = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((script) => script.js)
];
for (const file of referenced) assert.ok(await exists(file), `Fichier du manifeste introuvable : ${file}`);
assert.ok(!manifest.permissions.includes("tabs"), "Les permissions d'hôte suffisent : « tabs » n'est pas nécessaire.");

// Une seule version, reprise par la documentation.
const { version } = manifest;
const packageJson = JSON.parse(await read(extension, "package.json"));
assert.equal(packageJson.version, version, "package.json et manifest.json doivent porter la même version.");
for (const [base, document] of [[root, "README.md"], [root, "SECURITY.md"], [root, "TECHNIQUE.md"], [extension, "README.md"]]) {
  assert.ok((await read(base, document)).includes(`**${version}**`) || (await read(base, document)).includes(`version ${version}.**`),
    `${document} doit mentionner la version ${version}.`);
}

// Chaque suite de tests est lancée par npm test.
const registered = packageJson.scripts.test.split("&&").map((command) => command.trim().replace(/^node /, ""));
const suites = (await readdir(new URL("tests/", extension))).filter((name) => name.endsWith(".test.mjs")).map((name) => `tests/${name}`);
for (const suite of suites) assert.ok(registered.includes(suite), `${suite} n'est pas lancé par npm test.`);
for (const command of registered) assert.ok(command === "tests/project-check.mjs" || suites.includes(command), `Suite inconnue : ${command}`);

// lamejs 1.2.1 non modifié (empreinte du fichier publié sur npm).
const lame = await readFile(new URL("vendor/lame.min.js", extension));
const lameHash = createHash("sha256").update(lame).digest("hex");
assert.equal(lameHash, "15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4",
  "vendor/lame.min.js ne correspond plus à lamejs 1.2.1 : mettre à jour THIRD_PARTY_NOTICES.md.");
assert.ok((await read(extension, "THIRD_PARTY_NOTICES.md")).includes(lameHash), "L'empreinte de lamejs doit figurer dans les notices.");

console.log(`Projet cohérent : ${scripts.length} scripts, version ${version}, ${suites.length} suites enregistrées, lamejs vérifié`);
