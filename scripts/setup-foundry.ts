// Public upstream sources are pinned by archive digest or exact Git commit.
// Native Foundry binaries are required: npm launchers can hide compiler failures.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const foundryDir = join(repoRoot, "foundry");
const vendorDir = join(foundryDir, "vendor");
const tarballsDir = join(vendorDir, "tarballs");
const pinsFile = join(vendorDir, "PINS.json");

/** All upstream contract dependencies, pinned. `sha256` values verified from the pinned refs. */
const PINS = [
	{
		name: "forge-std",
		kind: "tarball",
		url: "https://codeload.github.com/foundry-rs/forge-std/tar.gz/refs/tags/v1.17.0",
		sha256: "f104cf27931254c647377aa46e308189a694dbd207f9af2e891c2547e8c03300",
		dir: "forge-std",
		strip: 1,
		version:
			"forge-std v1.17.0 (commit f3dae6e6ee381f25eb6a246f7da9b85c91a68219)",
	},
	{
		name: "swap-vm",
		kind: "tarball",
		url: "https://codeload.github.com/1inch/swap-vm/tar.gz/refs/tags/v1.0.2",
		sha256: "c1404ddeeeb1ad0d3407482d0b3aa25e61f8430b6c34d4732cf8b3c081f7c364",
		dir: "swap-vm",
		strip: 1,
		version:
			"1inch/swap-vm v1.0.2 (commit 32c687c2b73101fc26549e48fa1ff8a4d73afbac)",
	},
	{
		name: "aqua",
		kind: "tarball",
		url: "https://registry.npmjs.org/@1inch/aqua/-/aqua-1.0.1.tgz",
		sha256: "36549e4b2bdc98999b6d2d4111881dfa7d73e494a661d977d1c357e70e22ea65",
		dir: "aqua",
		strip: 1, // npm tarballs extract under package/
		version:
			"@1inch/aqua@1.0.1 (GitHub tag v1.0.1, commit 7219b1763b0099e7ab1e76b0f21053d95a6b69e5)",
	},
	{
		name: "solidity-utils",
		kind: "tarball",
		url: "https://registry.npmjs.org/@1inch/solidity-utils/-/solidity-utils-6.9.9.tgz",
		sha256: "79b2559c9af6d262a7bcb84854cd9ace8f7920c35e45fe41bda6b4cc3df205bb",
		dir: "solidity-utils",
		strip: 1,
		version:
			"@1inch/solidity-utils@6.9.9 (declared dependency of @1inch/aqua@1.0.1)",
	},
	{
		name: "openzeppelin",
		kind: "tarball",
		url: "https://registry.npmjs.org/@openzeppelin/contracts/-/contracts-5.4.0.tgz",
		sha256: "4e4d51f18935b32f0c877bf666ac37f5e5a98e75f03e7a77eb7569f84701f680",
		dir: "openzeppelin",
		strip: 1,
		version:
			"@openzeppelin/contracts@5.4.0 (declared dependency of @1inch/aqua@1.0.1)",
	},
	{
		name: "v2-core",
		kind: "tarball",
		url: "https://registry.npmjs.org/@uniswap/v2-core/-/v2-core-1.0.1.tgz",
		sha256: "f01288aaf73a89d2ff541b7276cec215ce2c480cafbed33b0da9c89853f976a2",
		dir: "uniswap/v2-core",
		strip: 1,
		version:
			"@uniswap/v2-core@1.0.1 (official interfaces used by UniversalRouter)",
	},
	{
		name: "v3-core",
		kind: "tarball",
		url: "https://registry.npmjs.org/@uniswap/v3-core/-/v3-core-1.0.0.tgz",
		sha256: "b74cf691f3713a6d6add72d861b5678c7bf2609ad8a0f53730e544e8e92d9928",
		dir: "uniswap/v3-core",
		strip: 1,
		version:
			"@uniswap/v3-core@1.0.0 (published artifacts; old solc 0.7.x — never compiled here)",
	},
	{
		name: "v3-periphery",
		kind: "tarball",
		url: "https://registry.npmjs.org/@uniswap/v3-periphery/-/v3-periphery-1.4.4.tgz",
		sha256: "7177174c4b8c66bd1d61e7c4127ee15e95f851edfb1a65ee8225b6ab4f818bd7",
		dir: "uniswap/v3-periphery",
		strip: 1,
		version:
			"@uniswap/v3-periphery@1.4.4 (published artifacts; old solc 0.7.x — never compiled here)",
	},
	{
		name: "permit2",
		kind: "git",
		url: "https://github.com/Uniswap/permit2",
		commit: "cc306b601f172c51bc04334a109e98340456620b",
		dir: "permit2",
		version:
			"Uniswap/permit2 @ cc306b601f172c51bc04334a109e98340456620b (isolated solc 0.8.17 graph)",
	},
	{
		name: "universal-router",
		kind: "git",
		url: "https://github.com/Uniswap/universal-router",
		commit: "f27061204cfe0cee4542fcb0e02db33d5c0c401f",
		dir: "universal-router",
		version:
			"Uniswap/universal-router @ f27061204cfe0cee4542fcb0e02db33d5c0c401f (main HEAD; V2/V3 exact-in layout with trailing minHopPriceX36 — the deployed '2.1.2' command layout; npm package stops at 2.1.0 which lacks it; isolated solc 0.8.26 graph)",
	},
] as const;

const run = (cmd: string[], cwd?: string) => {
	const res = spawnSync(cmd[0]!, cmd.slice(1), {
		cwd: cwd ?? repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 300_000,
	});
	if (res.error || res.signal || res.status !== 0)
		throw new Error(
			`${cmd.join(" ")} failed (${res.signal ?? res.status}):\n${res.error?.message ?? res.stderr ?? res.stdout ?? ""}`,
		);
	return (res.stdout ?? "").trim();
};

const sha256File = (path: string) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

const readPins = (): Record<string, unknown> =>
	existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, "utf8")) : {};
const writePins = (pins: Record<string, unknown>) => {
	mkdirSync(vendorDir, { recursive: true });
	writeFileSync(pinsFile, `${JSON.stringify(pins, null, "\t")}\n`);
};

async function download(url: string, dest: string): Promise<void> {
	const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
	writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function extractTarball(file: string, destDir: string, strip: number) {
	mkdirSync(destDir, { recursive: true });
	const res = spawnSync(
		"tar",
		["xzf", file, "-C", destDir, "--strip-components", String(strip)],
		{ encoding: "utf8" },
	);
	if (res.status !== 0)
		throw new Error(`tar extract failed for ${file}:\n${res.stderr}`);
}

function verifySourceTree(expected: string, actual: string): void {
	if (!lstatSync(actual).isDirectory())
		throw new Error(`Expected source directory: ${actual}`);
	const entries = readdirSync(expected, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const actualNames = readdirSync(actual).sort((a, b) => a.localeCompare(b));
	if (
		entries.length !== actualNames.length ||
		entries.some((entry, i) => entry.name !== actualNames[i])
	) {
		throw new Error(
			`Source file set differs from the pinned archive: ${actual}`,
		);
	}
	for (const entry of entries) {
		const original = join(expected, entry.name);
		const installed = join(actual, entry.name);
		const stat = lstatSync(installed);
		if (entry.isDirectory()) {
			verifySourceTree(original, installed);
		} else if (entry.isSymbolicLink()) {
			if (
				!stat.isSymbolicLink() ||
				readlinkSync(original) !== readlinkSync(installed)
			) {
				throw new Error(`Source symlink differs: ${installed}`);
			}
		} else if (
			!entry.isFile() ||
			!stat.isFile() ||
			!readFileSync(original).equals(readFileSync(installed))
		) {
			throw new Error(`Source contents differ: ${installed}`);
		}
	}
}

function verifyGitSource(destDir: string, commit: string): void {
	if (run(["git", "-C", destDir, "rev-parse", "HEAD"]) !== commit)
		throw new Error(`Git commit drift: ${destDir}`);
	if (
		run([
			"git",
			"-C",
			destDir,
			"status",
			"--porcelain",
			"--untracked-files=no",
			"--ignore-submodules=none",
		])
	)
		throw new Error(`Modified tracked source/submodule: ${destDir}`);
	const submodules = run([
		"git",
		"-C",
		destDir,
		"submodule",
		"status",
		"--recursive",
	]);
	// run() trims the leading space from the first good entry; invalid states retain +, - or U.
	if (submodules.split("\n").some((line) => /^[+\-U]/.test(line.trimStart())))
		throw new Error(`Unpinned or missing submodule: ${destDir}`);
}

function installGitDep(
	name: string,
	url: string,
	commit: string,
	destDir: string,
) {
	if (existsSync(join(destDir, ".git"))) {
		const head = run(["git", "-C", destDir, "rev-parse", "HEAD"]);
		if (head === commit) {
			verifyGitSource(destDir, commit);
			process.stdout.write(
				`[setup] ${name}: ${commit} present (clean source and recursive gitlinks verified)\n`,
			);
			return;
		}
		process.stdout.write(`[setup] ${name}: re-pinning ${head} -> ${commit}\n`);
	}
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(dirname(destDir), { recursive: true });
	run(["git", "clone", "--no-checkout", url, destDir]);
	run(["git", "-C", destDir, "checkout", "--detach", commit]);
	run([
		"git",
		"-C",
		destDir,
		"submodule",
		"update",
		"--init",
		"--recursive",
		"--depth",
		"1",
	]);
	verifyGitSource(destDir, commit);
	process.stdout.write(`[setup] ${name}: pinned ${commit}\n`);
}

async function installDep(pin: (typeof PINS)[number]): Promise<unknown> {
	if (pin.kind === "tarball") {
		const file = join(tarballsDir, `${pin.name}.tgz`);
		if (!existsSync(file) || sha256File(file) !== pin.sha256) {
			process.stdout.write(`[setup] ${pin.name}: downloading ${pin.url}\n`);
			await download(pin.url, file);
		}
		const actual = sha256File(file);
		if (actual !== pin.sha256) {
			throw new Error(
				`[setup] ${pin.name}: sha256 mismatch — expected ${pin.sha256}, got ${actual}. Refusing to vendor unverified bytes.`,
			);
		}
		const destDir = join(vendorDir, pin.dir);
		rmSync(destDir, { recursive: true, force: true });
		extractTarball(file, destDir, pin.strip);
		process.stdout.write(
			`[setup] ${pin.name}: ${pin.version} -> foundry/vendor/${pin.dir}\n`,
		);
		return {
			kind: pin.kind,
			url: pin.url,
			sha256: actual,
			dir: pin.dir,
			version: pin.version,
		};
	}
	const destDir = join(vendorDir, pin.dir);
	installGitDep(pin.name, pin.url, pin.commit, destDir);
	return {
		kind: pin.kind,
		url: pin.url,
		commit: pin.commit,
		dir: pin.dir,
		version: pin.version,
	};
}

function resolveForge(): string {
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	const name = process.platform === "win32" ? "forge.exe" : "forge";
	return createRequire(import.meta.url).resolve(
		`@foundry-rs/forge-${process.platform}-${arch}/bin/${name}`,
	);
}

function invokeForge(
	command: "build" | "test",
	profile: "fixture" | "permit2" | "router",
	paths: string[],
): void {
	const env = {
		...process.env,
		FOUNDRY_HOME: join(foundryDir, ".foundry"),
		FOUNDRY_PROFILE: profile,
	};
	process.stdout.write(`[${command}] ${profile}\n`);
	const res = spawnSync(
		resolveForge(),
		[command, "--root", foundryDir, ...paths],
		{ cwd: foundryDir, env, stdio: "inherit", timeout: 600_000 },
	);
	if (res.error || res.signal || res.status !== 0)
		throw new Error(
			`forge ${command} failed for ${profile} (${res.signal ?? res.status}): ${res.error?.message ?? "compiler/test failed"}`,
		);
}

function buildGraphs(): void {
	invokeForge("build", "fixture", ["contracts", "test"]);
	invokeForge("build", "permit2", ["vendor/permit2/src/Permit2.sol"]);
	invokeForge("build", "router", [
		"vendor/universal-router/contracts/UniversalRouter.sol",
	]);
	process.stdout.write(
		"[build] all three compiler processes exited successfully\n",
	);
}

async function main() {
	const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	const flags = process.argv.slice(2).filter((a) => a.startsWith("-"));
	const mode = args[0] ?? "all";
	if (
		!["all", "deps", "verify"].includes(mode) ||
		flags.some((flag) => !["--build", "--test"].includes(flag)) ||
		args.length > 1 ||
		(mode !== "all" && flags.length > 0)
	)
		throw new Error(
			"Usage: bun scripts/setup-foundry.ts [all|deps|verify] [--build] [--test]",
		);
	mkdirSync(tarballsDir, { recursive: true });

	if (mode === "verify") {
		const missing: string[] = [];
		for (const pin of PINS) {
			if (pin.kind === "tarball") {
				const file = join(tarballsDir, `${pin.name}.tgz`);
				if (!existsSync(file)) {
					missing.push(pin.name);
					continue;
				}
				const actual = sha256File(file);
				if (actual !== pin.sha256)
					throw new Error(
						`[verify] ${pin.name}: sha256 drift (${actual} != ${pin.sha256})`,
					);
				const expected = mkdtempSync(join(vendorDir, ".verify-"));
				try {
					extractTarball(file, expected, pin.strip);
					verifySourceTree(expected, join(vendorDir, pin.dir));
				} finally {
					rmSync(expected, { recursive: true, force: true });
				}
			} else {
				const destDir = join(vendorDir, pin.dir);
				if (!existsSync(join(destDir, ".git"))) {
					missing.push(pin.name);
					continue;
				}
				verifyGitSource(destDir, pin.commit);
			}
			process.stdout.write(`[verify] ${pin.name}: OK\n`);
		}
		if (missing.length > 0)
			throw new Error(
				`[verify] missing deps: ${missing.join(", ")} (run \`bun scripts/setup-foundry.ts deps\`)`,
			);
		if (!existsSync(pinsFile))
			process.stdout.write(
				"[verify] note: PINS.json not yet written; run deps once\n",
			);
		process.stdout.write("[verify] all pins verified\n");
		return;
	}

	if (mode === "deps" || mode === "all") {
		const pins = readPins();
		for (const pin of PINS) pins[pin.name] = await installDep(pin);
		writePins(pins);
		process.stdout.write(`[setup] pins recorded in ${pinsFile}\n`);
	}
	if (mode === "all" && flags.includes("--build")) buildGraphs();
	if (flags.includes("--test")) invokeForge("test", "fixture", []);
	process.stdout.write(
		"\nNext steps:\n  bun run demo:setup       # acquire and build all pinned graphs\n  bun run test:contracts   # native Forge tests with strict exit status\n  bun run demo             # owned local Anvil + official engines + mock Hub/providers\n",
	);
}

await main().catch((err: unknown) => {
	process.stderr.write(
		`${(err instanceof Error ? err.message : String(err)).trim()}\n`,
	);
	process.exitCode = 1;
});
