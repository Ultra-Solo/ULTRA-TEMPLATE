/** Commit the working candidate as a disposable, offline release fixture. */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function sourceFixture(root, version) {
  const source = mkdtempSync(join(tmpdir(), "template-fixture-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const file of git(root, "ls-files", "-z").split("\0").filter(Boolean)) {
    if (!existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(source, file)), { recursive: true });
    copyFileSync(join(root, file), join(source, file));
  }
  git(source, "init", "-q");
  git(source, "config", "core.autocrlf", "false");
  git(source, "add", "-A");
  git(source, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "candidate");
  git(source, "tag", `v${version}`);
  return source;
}
