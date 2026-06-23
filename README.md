# foundry-contract-deployer-server

A tiny local HTTP server that builds a [Foundry](https://book.getfoundry.sh/) project, lists its deployable contracts, and verifies them on Etherscan/Blockscout — exposed as a small JSON API for a deploy UI to talk to.

Run it from the root of a Foundry project. On startup it runs `forge build`, scans the `out/` directory for compiled artifacts that have bytecode, and serves them over HTTP.

## Requirements

- [Deno](https://deno.com/) (v1.40+)
- [Foundry](https://book.getfoundry.sh/) — `forge` must be on your `PATH`
- A Foundry project (a `foundry.toml` in the current directory)

## Usage

From your Foundry project root:

```bash
deno run \
  --allow-net=0.0.0.0 \
  --allow-run=forge \
  --allow-read=. \
  --allow-env=PORT \
  jsr:@command/foundry-contract-deployer-server
```

Or, working in this repo, use the dev task:

```bash
deno task dev
```

The server starts on `http://localhost:8420`. Override the port with the `PORT` environment variable:

```bash
PORT=9000 deno task dev
```

## How it works

1. Verifies the current directory is a Foundry project (`foundry.toml` exists), otherwise it exits.
2. Runs `forge build`. If the build fails, it prints the output and exits.
3. Reads the `src` path from `foundry.toml` (defaults to `src`) and **recursively** collects every `.sol` filename under it, including nested subdirectories (e.g. `src/tokens/MyToken.sol`).
4. Scans `out/` for compiled artifacts whose source file lives in `src/` and that have non-empty bytecode (i.e. deployable contracts — interfaces and abstract contracts are skipped).

## API

All responses are JSON and CORS is open (`Access-Control-Allow-Origin: *`) for local development.

| Method | Path             | Description                                                      |
| ------ | ---------------- | ---------------------------------------------------------------- |
| GET    | `/api/info`      | Returns `{ cwd, isFoundry }`.                                    |
| POST   | `/api/build`     | Runs `forge build`. Returns `{ ok, output }`.                    |
| GET    | `/api/contracts` | Lists deployable contracts: `[{ name, file, bytecode, abi }]`.   |
| POST   | `/api/verify`    | Runs `forge verify-contract`. Returns `{ ok, output }`.          |

### `POST /api/verify`

Request body:

```jsonc
{
  "contractName": "MyToken",
  "contractFile": "src/MyToken.sol",
  "address": "0x...",
  "chainId": 1,
  "verifier": "etherscan",        // or "blockscout"
  "etherscanKey": "...",          // required for etherscan
  "blockscoutUrl": "https://...", // required for blockscout
  "constructorArgs": "0x..."      // optional, ABI-encoded
}
```

## Permissions

The script requests the minimal Deno permissions it needs:

- `--allow-net=0.0.0.0` — serve the HTTP API
- `--allow-run=forge` — invoke `forge build` / `forge verify-contract`
- `--allow-read=.` — read `foundry.toml`, `src/`, and `out/`
- `--allow-env=PORT` — read the `PORT` override

## License

MIT
