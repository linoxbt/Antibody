// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

/// @dev Stands in for Reactive's system contract: records subscriptions and callback requests.
contract MockSystem {
    struct Sub { uint256 chainId; address target; uint256 topic0; }
    Sub[] public subs;
    ISystemContract.CallbackConfiguration_V_1_0[] internal cbs;

    function subscribe(uint256 chainId, address target, uint256 topic0, uint256, uint256, uint256) external {
        subs.push(Sub(chainId, target, topic0));
    }
    uint256 public unsubCount;
    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external { ++unsubCount; }
    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external { cbs.push(c); }
    function debt(address) external pure returns (uint256) { return 0; }
    function subCount() external view returns (uint256) { return subs.length; }
    function cbCount() external view returns (uint256) { return cbs.length; }
    function cb(uint256 i) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) { return cbs[i]; }
    receive() external payable {}
}

/// @dev Minimal ERC-20; `quiet` makes transfer return nothing (like USDT).
contract MockToken {
    mapping(address => uint256) public balanceOf;
    bool public quiet;
    bool public broken;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setQuiet(bool q) external { quiet = q; }
    function setBroken(bool b) external { broken = b; }
    fallback(bytes calldata data) external returns (bytes memory) {
        require(bytes4(data[:4]) == 0xa9059cbb, "only transfer");
        (address to, uint256 a) = abi.decode(data[4:], (address, uint256));
        if (broken) return abi.encode(false);
        require(balanceOf[msg.sender] >= a, "balance");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return quiet ? bytes("") : abi.encode(true);
    }
}

/// @dev A payee that refuses native coin.
contract RefusingPayee {
    receive() external payable { revert("no"); }
}
