#!/usr/bin/env -S deno run --allow-net=0.0.0.0 --allow-run=forge --allow-read=. --allow-env=PORT

const PORT = parseInt(Deno.env.get("PORT") || "8420");
const CWD = Deno.cwd();

/** Check if CWD is a Foundry project */
async function isFoundryProject(dir: string): Promise<boolean> {
  try {
    await Deno.stat(`${dir}/foundry.toml`);
    return true;
  } catch {
    return false;
  }
}

/** Run forge build */
async function forgeBuild(dir: string): Promise<{ ok: boolean; output: string }> {
  const cmd = new Deno.Command("forge", {
    args: ["build"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { ok: result.success, output: stdout + stderr };
}

/** Read foundry.toml to find src dir */
async function getSrcDir(dir: string): Promise<string> {
  try {
    const toml = await Deno.readTextFile(`${dir}/foundry.toml`);
    const match = toml.match(/^src\s*=\s*"(.+)"/m);
    return match ? match[1] : "src";
  } catch {
    return "src";
  }
}

/** Recursively collect .sol file names under a directory */
async function collectSolFiles(dir: string, found: Set<string>): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await collectSolFiles(path, found);
      } else if (entry.isFile && entry.name.endsWith(".sol")) {
        // out/ is keyed by the .sol basename, so collect basenames only
        found.add(entry.name);
      }
    }
  } catch {
    // dir doesn't exist or isn't readable
  }
}

/** Scan the out/ directory for compiled contracts */
async function getContracts(dir: string): Promise<
  Array<{ name: string; file: string; bytecode: string; abi: unknown[] }>
> {
  const srcDir = await getSrcDir(dir);
  const outDir = `${dir}/out`;
  const contracts: Array<{
    name: string;
    file: string;
    bytecode: string;
    abi: unknown[];
  }> = [];

  // Collect source files recursively under src/ (Foundry allows nested dirs)
  const srcFiles = new Set<string>();
  await collectSolFiles(`${dir}/${srcDir}`, srcFiles);

  try {
    for await (const entry of Deno.readDir(outDir)) {
      if (!entry.isDirectory || !entry.name.endsWith(".sol")) continue;

      const solName = entry.name;
      // Only include contracts whose .sol file is in src/
      if (!srcFiles.has(solName)) continue;

      const contractDir = `${outDir}/${solName}`;

      for await (const jsonEntry of Deno.readDir(contractDir)) {
        if (!jsonEntry.name.endsWith(".json") || jsonEntry.name.includes(".dbg.")) continue;

        const jsonPath = `${contractDir}/${jsonEntry.name}`;
        try {
          const raw = await Deno.readTextFile(jsonPath);
          const artifact = JSON.parse(raw);

          const bytecode = artifact?.bytecode?.object;
          if (!bytecode || bytecode === "0x" || bytecode.length < 10) continue;

          const contractName = jsonEntry.name.replace(".json", "");

          contracts.push({
            name: contractName,
            file: solName,
            bytecode,
            abi: artifact.abi || [],
          });
        } catch {
          // skip malformed JSON
        }
      }
    }
  } catch {
    // out/ doesn't exist yet
  }

  // Sort by name
  contracts.sort((a, b) => a.name.localeCompare(b.name));
  return contracts;
}

/** HTTP handler */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS headers for local dev
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // API: project info
  if (url.pathname === "/api/info") {
    const isFoundry = await isFoundryProject(CWD);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ cwd: CWD, isFoundry }), { headers });
  }

  // API: build
  if (url.pathname === "/api/build" && req.method === "POST") {
    const result = await forgeBuild(CWD);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(result), { headers });
  }

  // API: list contracts
  if (url.pathname === "/api/contracts") {
    const contracts = await getContracts(CWD);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(contracts), { headers });
  }

  // API: verify contract
  if (url.pathname === "/api/verify" && req.method === "POST") {
    const body = await req.json();
    const { contractName, contractFile, address, chainId, verifier, etherscanKey, constructorArgs } = body;

    const args: string[] = [
      "verify-contract",
      address,
      `${contractFile}:${contractName}`,
      "--chain-id", String(chainId),
    ];

    if (verifier === "blockscout") {
      args.push("--verifier", "blockscout");
      if (body.blockscoutUrl) {
        args.push("--verifier-url", body.blockscoutUrl + "/api?");
      }
    } else {
      // etherscan (default)
      args.push("--verifier", "etherscan");
      if (etherscanKey) {
        args.push("--etherscan-api-key", etherscanKey);
      }
    }

    if (constructorArgs) {
      args.push("--constructor-args", constructorArgs);
    }

    const cmd = new Deno.Command("forge", {
      args,
      cwd: CWD,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ ok: result.success, output: stdout + stderr }), { headers });
  }

  return new Response("Not Found", { status: 404 });
}

// Main
if (!await isFoundryProject(CWD)) {
  console.error("Error: No foundry.toml found in current directory.");
  console.error("Please run this command from a Foundry project root.");
  Deno.exit(1);
}

console.log(`Building contracts in ${CWD} ...`);
const buildResult = await forgeBuild(CWD);
if (!buildResult.ok) {
  console.error("forge build failed:");
  console.error(buildResult.output);
  Deno.exit(1);
}
console.log("Build OK");

const contracts = await getContracts(CWD);
console.log(`Found ${contracts.length} deployable contract(s): ${contracts.map((c) => c.name).join(", ")}`);

console.log(`\nServer running at http://localhost:${PORT}`);

Deno.serve({ port: PORT }, handler);
