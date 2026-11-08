"use strict";
/**
 * Resolution of `import "Owner:repo"` packages installed by `mylang install`
 * into `.module/<owner>/<repo>`.
 *
 * Mirrors the interpreter (`src/utils/packages.ts` of the language): the
 * `.module` folder and `mylang.json` are searched in the folder of the importing
 * file and then in every parent folder, like `node_modules`.
 */

const fs = require("fs");
const path = require("path");

const MODULES_DIR = ".module";

/** `"Owner:repo"` -> `{owner, name}`; `null` if `source` is not a package reference. */
function parsePackageSource(source) {
  const index = source.indexOf(":");
  if (index <= 0) return null;
  const owner = source.slice(0, index);
  const name = source.slice(index + 1);
  if (!name || /[\\/]/.test(owner) || name.includes(":")) return null;
  return { owner, name };
}

function* walkUp(startDir) {
  let dir = startDir;
  for (;;) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function describe(dir, root, owner, name) {
  const config = readJSON(path.join(dir, "mylang.json")) || {};
  return {
    source: `${owner}:${name}`,
    owner,
    name,
    dir,
    root,
    config,
    version: typeof config.version === "string" ? config.version : "",
    description: typeof config.description === "string" ? config.description : "",
    main: path.join(dir, typeof config.main === "string" && config.main ? config.main : "index.ml"),
  };
}

/** The installed package a source resolves to from `startDir`, or `null`. */
function findInstalledPackage(startDir, source) {
  const ref = parsePackageSource(source);
  if (!ref) return null;
  for (const root of walkUp(startDir)) {
    const dir = path.join(root, MODULES_DIR, ref.owner, ref.name);
    if (isDir(dir)) return describe(dir, root, ref.owner, ref.name);
  }
  return null;
}

/** Is the package listed in `dependencies` / `devDependencies` of a nearby `mylang.json`? */
function isDeclaredDependency(startDir, source) {
  const ref = parsePackageSource(source);
  if (!ref) return false;
  for (const dir of walkUp(startDir)) {
    const config = readJSON(path.join(dir, "mylang.json"));
    if (!config) continue;
    for (const bucket of ["dependencies", "devDependencies"]) {
      const deps = config[bucket];
      if (!deps || typeof deps !== "object") continue;
      if (
        Object.prototype.hasOwnProperty.call(deps, ref.name) ||
        Object.values(deps).some((v) => String(v).split("@")[0] === source)
      )
        return true;
    }
  }
  return false;
}

/**
 * Status of an import, in the same order the interpreter checks it:
 * not declared -> not installed -> missing main file.
 * @returns {{status:"ok"|"not-declared"|"not-installed"|"no-main", pkg:object|null}}
 */
function resolvePackage(startDir, source) {
  if (!isDeclaredDependency(startDir, source)) return { status: "not-declared", pkg: null };
  const pkg = findInstalledPackage(startDir, source);
  if (!pkg) return { status: "not-installed", pkg: null };
  if (!fs.existsSync(pkg.main)) return { status: "no-main", pkg };
  return { status: "ok", pkg };
}

/** Every package installed in `.module` folders visible from `startDir` (nearest wins). */
function listInstalledPackages(startDir) {
  const found = new Map();
  for (const root of walkUp(startDir)) {
    const modules = path.join(root, MODULES_DIR);
    if (!isDir(modules)) continue;
    let owners = [];
    try {
      owners = fs.readdirSync(modules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const o of owners) {
      if (!o.isDirectory() || o.name.startsWith(".")) continue;
      let names = [];
      try {
        names = fs.readdirSync(path.join(modules, o.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.isDirectory() || n.name.startsWith(".")) continue;
        const source = `${o.name}:${n.name}`;
        if (!found.has(source))
          found.set(source, describe(path.join(modules, o.name, n.name), root, o.name, n.name));
      }
    }
  }
  return [...found.values()];
}

module.exports = {
  MODULES_DIR,
  parsePackageSource,
  findInstalledPackage,
  isDeclaredDependency,
  resolvePackage,
  listInstalledPackages,
};
