// Remove only a direct child catalogue that was offered by the imported-KB listing.
const path = require("node:path");

async function removeImportedCatalogue(rootPath, io) {
  const catalogues = (await io.list()).filter((item) =>
    item.isDirectory && !item.isSymbolicLink && typeof item.name === "string");
  if (!catalogues.length) return { status: "empty" };

  const name = await io.choose(catalogues.map((item) => item.name));
  if (name == null) return { status: "cancelled" };
  if (!catalogues.some((item) => item.name === name)) throw new Error("The selected catalogue is no longer available.");

  const root = path.resolve(rootPath);
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!name || path.basename(name) !== name || !relative || relative === ".."
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The selected catalogue is outside the imported knowledge-base directory.");
  }
  if (!(await io.confirm(name))) return { status: "cancelled" };

  await io.remove(target);
  return { status: "removed", name };
}

module.exports = { removeImportedCatalogue };
