// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PoolKeyRegistry
/// @notice A public, permissionless `poolId -> PoolKey` lookup for Arc.
///
/// # Why this exists
///
/// A Uniswap v4 pool is addressed by `poolId = keccak256(abi.encode(PoolKey))`.
/// A hash is one-way, so a poolId alone does not tell you the pool's currencies,
/// fee, tick spacing or hook. The only on-chain record of a key is the
/// `PoolManager.Initialize` event emitted once, at creation.
///
/// That makes a poolId nearly unusable for anyone arriving later:
///
///   * recovering a key means scanning logs, and Arc rejects wide ranges with
///     `-32012 requested range too large`, so the scan has to be narrowed to a
///     window around a block you must first locate by timestamp;
///   * the public RPC rate limits, so doing this for many pools is slow and
///     unreliable — in practice the first lookup for one token takes tens of
///     seconds;
///   * a contract cannot do it at all. There is no way to read a past event
///     from inside the EVM, so any on-chain logic holding a poolId is stuck
///     with an opaque 32-byte value.
///
/// This registry turns that one-time event into permanent, free, composable
/// state. Anyone may submit a key; the contract keeps it only if its hash
/// matches the id it claims, so a wrong or malicious entry is impossible rather
/// than merely discouraged. There is no owner, no admin and no upgrade path:
/// nothing here can be changed by anybody, including whoever deploys it.
///
/// # What it deliberately does NOT do
///
/// It does not check that the pool exists, is initialized, holds liquidity, or
/// is safe to trade. A registered key proves exactly one thing: these five
/// fields hash to this id. Pricing and sellability are a separate question and
/// are answered off-chain by the service in this repository, because they
/// depend on the quoter and on a pinned block.
contract PoolKeyRegistry {
    /// @dev Field order and types mirror Uniswap v4's `PoolKey` exactly. All
    /// five members are static, so the struct is a static ABI type and
    /// `abi.encode` lays it out as five 32-byte words — 160 bytes, the same
    /// `0xa0` length v4's `PoolIdLibrary.toId` hashes over. Reordering or
    /// resizing any field here would silently produce a different id and make
    /// every entry wrong, which is why it is spelled out rather than imported.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    mapping(bytes32 => PoolKey) private _key;
    mapping(bytes32 => bool) private _known;

    /// @notice How many distinct pools have been registered.
    uint256 public total;

    /// @notice Emitted the first time a pool is registered. Fields are
    /// unpacked rather than emitted as a struct so that log consumers can read
    /// them without the ABI.
    event Registered(
        bytes32 indexed poolId,
        address indexed currency0,
        address indexed currency1,
        uint24 fee,
        int24 tickSpacing,
        address hooks
    );

    /// @notice The id a key hashes to. Pure, so it costs nothing to check a key
    /// against an id you already hold before spending gas on `register`.
    function idOf(PoolKey calldata key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice Record a key. Idempotent: submitting a key that is already
    /// stored succeeds and changes nothing, so callers racing to register the
    /// same pool never revert against each other.
    /// @dev No access control and no validation of the key's contents is
    /// needed. The id is *derived* from the key, so a caller cannot associate a
    /// key with an id it does not hash to — the worst a hostile caller can do
    /// is pay gas to store a key for a pool nobody cares about.
    function register(PoolKey calldata key) external returns (bytes32 poolId) {
        poolId = keccak256(abi.encode(key));
        if (!_known[poolId]) {
            _key[poolId] = key;
            _known[poolId] = true;
            unchecked { ++total; }
            emit Registered(
                poolId, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks
            );
        }
    }

    /// @notice Record many keys in one transaction.
    /// @return added How many were new. The rest were already present.
    function registerMany(PoolKey[] calldata keys) external returns (uint256 added) {
        uint256 n = keys.length;
        for (uint256 i; i < n; ) {
            bytes32 poolId = keccak256(abi.encode(keys[i]));
            if (!_known[poolId]) {
                _key[poolId] = keys[i];
                _known[poolId] = true;
                unchecked { ++added; }
                emit Registered(
                    poolId,
                    keys[i].currency0,
                    keys[i].currency1,
                    keys[i].fee,
                    keys[i].tickSpacing,
                    keys[i].hooks
                );
            }
            unchecked { ++i; }
        }
        unchecked { total += added; }
    }

    /// @notice Look up a key.
    /// @dev Returns a `found` flag instead of reverting on an unknown id. An
    /// unknown pool is an ordinary, expected answer, and a revert would force
    /// every on-chain caller into a try/catch to handle the common case.
    /// A zeroed key with `found == false` must never be read as a real pool
    /// whose fields happen to be zero.
    function get(bytes32 poolId) external view returns (bool found, PoolKey memory key) {
        found = _known[poolId];
        if (found) key = _key[poolId];
    }

    /// @notice Look up many keys in one call.
    function getMany(bytes32[] calldata poolIds)
        external
        view
        returns (bool[] memory found, PoolKey[] memory keys)
    {
        uint256 n = poolIds.length;
        found = new bool[](n);
        keys = new PoolKey[](n);
        for (uint256 i; i < n; ) {
            if (_known[poolIds[i]]) {
                found[i] = true;
                keys[i] = _key[poolIds[i]];
            }
            unchecked { ++i; }
        }
    }

    /// @notice Whether an id is registered, without returning the key.
    function isKnown(bytes32 poolId) external view returns (bool) {
        return _known[poolId];
    }
}
