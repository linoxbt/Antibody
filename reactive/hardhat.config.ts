import { defineConfig } from 'hardhat/config';

// Import remappings live in remappings.txt (Hardhat 3 reads it). The optimizer keeps GuardReactive under
// the 24 KB contract size limit; contracts deployed before it was enabled were compiled without it.
export default defineConfig({
  solidity: { profiles: { default: { version: '0.8.30', settings: { optimizer: { enabled: true, runs: 200 } } } } },
  paths: { sources: './contracts', tests: { solidity: './test' } },
});
