# arc-depth

**Which pool should this Arc token trade through, and what does a round trip actually cost?**

A read-only service for [Arc](https://www.arc.io) (Circle's L1, chain id 5042). Give it a token address and a size in USDC; it quotes a full round trip — buy then sell — through every Uniswap v4 pool that token has, at a single pinned block, and tells you which route is cheapest and which is a trap.

No wallet. No signing. No transactions. No approvals. Every number comes from an `eth_call` quote.

<!-- CANLI:BAS -->
**Live demo:** https://related-involves-idea-seat.trycloudflare.com

```bash
curl "https://related-involves-idea-seat.trycloudflare.com/sellable?token=0xa39c8e2ceb2a0f9d6e9d059f5e470edfda691c15&size=5"
```

_Served through a Cloudflare quick tunnel, which needs no account and costs
nothing but is handed a new hostname whenever it restarts. If this link is
unreachable, that is what happened — it is not a claim that the service is
broken. `npm install && npm start` gives you the same service locally, and
`/health` on either tells you what it is pointed at._
<!-- CANLI:SON -->

---

## Why this exists

On Arc a single token routinely has dozens of pools. Measured on mainnet, the token `AI` had **20 indexed pools**, and the round-trip cost for 5 USDC differed enormously between them:

| pool fee | hook | liquidity | round trip |
|---:|:---|---:|---:|
| 1% | custom | $30,844 | **7.85%** |
| 5% | none | $786 | 12.20% |
| 25% | none | $24 | 65.18% |
| 89% | none | $25 | **99.16%** |

Same token, same block. Route through the first pool and you pay 7.85%. Route through the last and **99% of the position is gone** — with no rug, no honeypot, no malice. Just the wrong pool.

Arc-wide, from a scan of the pool index: **15,616 pools charge 50% or more.** Nothing published on Arc tells a buyer which of a token's pools is the usable one.

### Existing Arc scanners can't answer this, and say so

From [Smithii's Arc rug checker](https://smithii.io/en/rug-check-arc/):

> "token scanners rely on third-party providers that simulate buys and sells to catch honeypots, and those providers don't cover Arc yet"

Their honeypot, tax and holder-concentration checks all return **Unknown** on Arc, and their suggested workaround is to *"buy a tiny amount and try to sell it right away."*

That is exactly what this service does — as a quote, so it costs nothing and risks nothing.

---

## Usage

```bash
npm install
npm start                 # listens on :8712
npm run check             # self-checks, including a live end-to-end quote
```

```
GET /sellable?token=0x...&size=5
GET /health
```

### Example

```bash
curl "http://localhost:8712/sellable?token=0xa39c8e2ceb2a0f9d6e9d059f5e470edfda691c15&size=5"
```

```json
{
  "result": "SELLABLE",
  "sellable": true,
  "poolsFound": 20,
  "block": 24204153,
  "pinStatus": "VERIFIED",
  "bestPool": "0xc362f08b2d...",
  "bestRoundTripPct": 7.85,
  "worstRoundTripPct": 99.16,
  "routingWarning": "Pools for this token differ by 91.31 percentage points. Routing through the wrong one is the main risk here, not the token itself.",
  "explanation": "Cheapest route costs 7.85% for a 5 USDC round trip, the most expensive measured pool costs 99.16%. The figure includes fees and price impact."
}
```

| field | meaning |
|---|---|
| `sellable` | `true`, `false`, or `null`. **`null` means unmeasured, not unsafe.** |
| `bestRoundTripPct` | cheapest buy-then-sell cost, fees *and* price impact included |
| `routingWarning` | present when pools differ by more than 10 percentage points |
| `pinStatus` | `VERIFIED` means both legs came from the same block hash |
| `pools[]` | per-pool fee, tick spacing, hook address, liquidity, status |

---

## How it works

1. **List the token's pools** from GeckoTerminal (public, keyless).
2. **Recover each PoolKey.** A v4 pool id is `keccak(PoolKey)` and is not reversible, so the key is read from the `PoolManager.Initialize` event that created the pool. The pool's creation time is resolved to a block by binary search, then a narrow `eth_getLogs` window is filtered by the pool id topic — one precise hit instead of scanning the chain. Keys are immutable, so they are cached permanently (first query ~35 s, afterwards ~11 s).
3. **Quote both legs at the same pinned block**: USDC → token, then *exactly that token amount* → USDC. The second leg must consume the first leg's output; feeding it an arbitrary amount ignores the first leg's price impact and understates the cost.
4. **Re-read the block hash.** If it moved, the result is reported as unverified rather than quietly trusted.

---

## On-chain: the PoolKey registry

> **Deployed on Arc mainnet:** [`0x0B3dD19678eba80fFd986B970FE0aeD54E7Ef801`](https://explorer.arc.io/address/0x0B3dD19678eba80fFd986B970FE0aeD54E7Ef801)
> &nbsp;&nbsp;block 24228647 &middot; 8 pools registered &middot; no owner, no admin, no upgrade path

A v4 pool id is `keccak256(abi.encode(PoolKey))`. A hash is one-way, so an id
alone tells you nothing about the pool it names — not the currencies, the fee,
the tick spacing, or the hook. The only on-chain record of a key is the
`Initialize` event emitted once when the pool was created.

That leaves anyone arriving later with an awkward problem, and leaves a
**contract with no option at all**: the EVM cannot read a past event, so
on-chain logic holding a poolId is stuck with an opaque 32 bytes.

[`contracts/PoolKeyRegistry.sol`](contracts/PoolKeyRegistry.sol) is a
permissionless `poolId -> PoolKey` lookup that fixes this. Anyone may submit a
key; the contract keeps it only if its hash matches the id it claims, so a
wrong entry is **impossible rather than merely discouraged**. There is no owner,
no admin function and no upgrade path — nothing in it can be changed by anyone,
including whoever deploys it.

```solidity
function idOf(PoolKey calldata key) external pure returns (bytes32);
function register(PoolKey calldata key) external returns (bytes32 poolId);
function registerMany(PoolKey[] calldata keys) external returns (uint256 added);
function get(bytes32 poolId) external view returns (bool found, PoolKey memory key);
function getMany(bytes32[] calldata ids) external view returns (bool[] memory, PoolKey[] memory);
function isKnown(bytes32 poolId) external view returns (bool);
```

`get` returns a `found` flag rather than reverting on an unknown id, because an
unknown pool is an ordinary answer and a revert would push every on-chain caller
into a try/catch for the common case. A zeroed key with `found == false` must
never be read as a real pool whose fields happen to be zero.

### Verification

```bash
npm run contract:build     # compile with the local solc, no service needed
npm run contract:check     # run the COMPILED code in Arc's own EVM
```

The check does not test a belief about `abi.encode`. It places the compiled
runtime code at a throwaway address using `eth_call`'s state override, calls
`idOf` on eight real Arc pools, and compares the result to the ids
`PoolManager` actually assigned — including the 89% and 90% fee tiers, where a
mis-sized field would show up. All eight match. No transaction is sent and no
key is needed, and if a node does not support state overrides the check says so
instead of passing vacuously.

Measured on Arc mainnet, from the actual deployment: **844,932 gas
(0.017 USDC)** to deploy and **665,288 gas (0.013 USDC)** to register the first
eight keys — about 83,000 gas, or 0.0017 USDC, per key.

Afterwards the code at the address was fetched back and compared byte for byte
with what was compiled, because a receipt with status 1 only says the
transaction did not revert; it does not say the chain now holds the code that
passed the checks. It matched. Every registered key was then read back through
a separate raw-RPC client instead of the deploy run's own contract handle, and
an unknown id was confirmed to return `found == false` rather than reverting.
Eight of eight correct.

### What the registry deliberately does not do

A registered key proves exactly one thing: these five fields hash to this id.
It says nothing about whether the pool exists, is initialized, holds liquidity,
or is safe to trade. Those are pricing questions, they depend on the quoter and
on a pinned block, and they are answered off-chain by the service above. Keeping
the two apart is the point — a registry that also made claims about safety would
be asserting on-chain something it cannot verify on-chain.

---

## What this does not claim

Honest limits, stated because a measurement tool that overclaims is worse than none:

- **A failed call is not a verdict.** Quote failures are reported as `UNMEASURED`, never as "cannot sell". Treating a network error as a honeypot stamps healthy pools as traps.
- **Uniswap v4 only.** Arc also has v3 pools; the v4 quoter cannot price them and they are not covered.
- **Dynamic-fee pools are flagged, not priced.** When `fee == 2^23` the hook sets the fee at swap time, so no fixed percentage is honest.
- **One block only.** Hook behaviour and liquidity can change in the next block. This is a measurement, not a guarantee.
- **`execution reverted` with no decodable payload is ambiguous.** It may be the pool refusing the swap or the call failing. It is classified conservatively as `UNMEASURED`.
- **The public Arc RPC is rate limited.** Back-to-back requests will degrade. Rate limiting is backed off and retried rather than reported as a result, and `npm run check` marks a throttled check `LIMIT` rather than `FAIL`, because a closed rate-limit window says nothing about the code. Serving real traffic needs a dedicated endpoint.

---

## Notes from building it

Three bugs here failed *silently* — returning plausible numbers instead of errors — and each is now covered by `npm run check`:

- **Hand-rolled ABI encoding was wrong twice.** A missing offset word for the dynamic outer tuple, then a further mismatch. Caught only by encoding the same call with a reference coder and comparing byte for byte. Encoding is now delegated to `ethers`; the raw JSON-RPC client is kept, because `JsonRpcProvider` retried network detection forever against a dead endpoint and masked real errors behind `could not coalesce error`.
- **Timestamp-to-block arithmetic drifted by up to fourteen hours.** A fixed 0.5074 s block time was off by 48,184 blocks at the chain head and 101,173 at block 1M. That would have centred the event window nowhere near the pool, and an empty result is indistinguishable from "no Initialize event". Replaced with binary search over real block timestamps: exact to 0–2 blocks.
- **Arc returns two different RPC errors that need opposite handling.** `-32012 requested range too large` is permanent — retrying is pointless and the range must be narrowed. Rate limiting is transient and should be backed off. Collapsing them into one class either wastes calls or drops data. Getting this half right is just as bad: the first version did retry a rate limit, but on the same short linear backoff as a dropped socket, so all three attempts landed inside the same closed window. A clean clone then reported `1 CHECK(S) FAILED` for an endpoint that was merely busy — a tool that overstates its own breakage is as misleading as one that hides it. Rate limits now get their own exponential schedule (1.5s to 30s, capped), honour `Retry-After`, and draw from a separate retry budget so a busy window cannot consume the retries meant for network faults.

---

## Configuration

| variable | default |
|---|---|
| `ARC_RPC` | `https://rpc.mainnet.arc.io` |
| `PORT` | `8712` |
| `RATE_PER_MIN` | `20` per IP |
| `MAX_POOLS` | `8` pools quoted per request |
| `MAX_SIZE` | `500` USDC |
| `POOLKEY_CACHE` | `data/poolkeys.json` |

The cache holds only derived public data (pool id, currencies, fee, tick spacing, hook address). Deleting it costs speed, never correctness.

## License

MIT

---

## Running it publicly

```bash
npm start                                     # service on :8712, serves the demo at /
cloudflared tunnel --url http://127.0.0.1:8712   # temporary public URL, no account needed
```

A `trycloudflare.com` quick tunnel needs no signup and costs nothing, but the
hostname **changes every time the tunnel restarts**. It is fine for a demo and
for sharing a link; a stable address needs a named tunnel or ordinary hosting.

What is exposed: two read-only GET endpoints and a static page. No wallet, no
keys, no write path. Requests are rate limited per IP and the quote size is
capped, because the public Arc RPC behind it is shared.
