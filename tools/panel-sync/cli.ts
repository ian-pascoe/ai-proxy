/**
 * `pnpm panel:sync`: installs `public/management.html` (the control panel served at `/management.html`).
 *
 *   pnpm panel:sync [--repository owner/repo] [--tag vX.Y.Z] [--out path] [--allow-unverified]
 *
 * `GITHUB_TOKEN` is used for the GitHub API when set. The file is replaced atomically and only after its SHA-256
 * matched the release digest. It is large (~3 MB) and therefore git-ignored: run this before `pnpm run deploy`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPanel, PanelSyncError } from "./release.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const parseArgs = (argv: ReadonlyArray<string>) => {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === undefined) continue;

    if (arg === "--allow-unverified") flags.add("allow-unverified");
    else if (arg.startsWith("--") && next !== undefined) {
      values.set(arg.slice(2), next);
      index += 1;
    } else throw new PanelSyncError("invalid_repository", `unknown argument: ${arg}`);
  }

  return { values, flags };
};

const main = async (): Promise<void> => {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const target = resolve(root, values.get("out") ?? "public/management.html");
  let installed: string | undefined;

  try {
    installed = createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch {
    installed = undefined;
  }

  const repository = values.get("repository");
  const tag = values.get("tag");
  const token = process.env.GITHUB_TOKEN;

  const result = await fetchPanel({
    ...(repository === undefined ? {} : { repository }),
    ...(tag === undefined ? {} : { tag }),
    ...(token === undefined ? {} : { token }),
    ...(installed === undefined ? {} : { installedSha256: installed }),
    allowUnverified: flags.has("allow-unverified"),
  });

  if (result.status === "up-to-date") {
    out(`management.html is up to date (${result.tag}, sha256 ${result.sha256})`);

    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, result.bytes);
  renameSync(temporary, target);
  out(
    `installed management.html ${result.tag} (${result.bytes.length} bytes, sha256 ${result.sha256})`,
  );
};

main().catch((cause: unknown) => {
  process.stderr.write(
    `panel:sync failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exitCode = 1;
});
