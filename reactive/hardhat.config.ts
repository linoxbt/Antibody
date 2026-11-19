import { defineConfig } from 'hardhat/config';

// Import remappings live in remappings.txt (Hardhat 3 reads it).
export default defineConfig({
  solidity: { profiles: { default: { version: '0.8.30' } } },
  paths: { sources: './contracts', tests: { solidity: './test' } },
});
