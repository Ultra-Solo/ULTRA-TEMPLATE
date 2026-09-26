/**
 * Installs the dependencies of every module present, with the command its toolchain declares in
 * TOOLCHAINS (scripts/modules.mjs): the one that installs exactly what the lockfile pins and refuses a
 * lockfile that no longer matches its manifest, or, for a module whose first lockfile is not written
 * yet, the one that writes it.
 *
 * npm installs run with --ignore-scripts: no dependency's install script runs on this machine, which
 * is how npm worms spread. The flag covers installation only; `npm run` and `npm pack` behave as usual.
 *
 *   node scripts/setup.mjs              # every module present
 *   node scripts/setup.mjs web          # only the modules named, as a module's CI job does
 *
 * Exit 0 all installed · 1 an install failed · 2 a module name that is not present, or a malformed manifest.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkNodeVersion, ModuleError, presentModules, ROOT, run, TOOLCHAINS, withToolsBin } from "./modules.mjs";

process.env.PATH = withToolsBin(process.env.PATH);

// Installing under another Node major than CI's gives a working tree that verifies differently.
const wrongNode = checkNodeVersion();
if (wrongNode !== null) {
  console.error(`setup: ${wrongNode}`);
  process.exit(1);
}

let present;
try {
  present = presentModules();
} catch (err) {
  if (!(err instanceof ModuleError)) throw err;
  console.error(`setup: ${err.message}`);
  process.exit(2);
}
const requested = process.argv.slice(2);
const absent = requested.filter((id) => !present.some((m) => m.id === id));
if (absent.length > 0) {
  console.error(`setup: no module named ${absent.join(", ")} here. Present: ${present.map((m) => m.id).join(", ") || "none"}.`);
  process.exit(2);
}

let failed = 0;
for (const module of present.filter((m) => requested.length === 0 || requested.includes(m.id))) {
  const cwd = join(ROOT, module.dir);
  const toolchain = TOOLCHAINS[module.toolchain];
  // A module without its lockfile yet installs unlocked, which writes the lockfile; rule 13 then
  // refuses to let it be committed without it.
  const locked = toolchain.lockfile === null || existsSync(join(cwd, toolchain.lockfile)) || toolchain.installUnlocked === null;
  const [command, ...args] = locked ? toolchain.install : toolchain.installUnlocked;
  console.log(`\n▶ ${module.id}: ${command} ${args.join(" ")}`);
  const { status } = run(command, args, { cwd });
  if (status !== 0) {
    failed++;
    // 127 is what run() returns when the command could not start at all: name the missing tool,
    // or the only clue is a red line that says nothing about why.
    const why = status === 127 ? ` ${command} is not on PATH; install it or remove the module.` : "";
    console.error(`setup: ${module.id} failed to install.${why}`);
  }
}
if (failed === 0) console.log("\nsetup: OK — next, node scripts/verify.mjs");
process.exitCode = failed === 0 ? 0 : 1;
