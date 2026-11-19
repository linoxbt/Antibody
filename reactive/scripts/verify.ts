// Verify a deployed contract on Sourcify from Hardhat's build info:
//   npx tsx scripts/verify.ts <network> <Contract> <address> [creationTxHash]
import { readFileSync } from 'node:fs';
import { NETWORKS } from '../networks.ts';
import { sleep, type NetworkName } from './lib.ts';

const [net, contract, address, creationTx] = process.argv.slice(2) as [NetworkName, string, string, string?];
if (!net || !contract || !address) throw new Error('usage: verify.ts <network> <Contract> <address> [creationTxHash]');
const root = new URL('..', import.meta.url).pathname;
const art = JSON.parse(readFileSync(`${root}artifacts/contracts/${contract}.sol/${contract}.json`, 'utf8'));
const info = JSON.parse(readFileSync(`${root}artifacts/build-info/${art.buildInfoId}.json`, 'utf8'));
const API = 'https://sourcify.dev/server';

const res = await fetch(`${API}/v2/verify/${NETWORKS[net].chainId}/${address}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    stdJsonInput: info.input, compilerVersion: info.solcLongVersion,
    contractIdentifier: `${art.inputSourceName}:${contract}`, ...(creationTx ? { creationTransactionHash: creationTx } : {}),
  }),
});
const body: any = await res.json();
if (res.status === 409) { console.log('already verified'); process.exit(0); }
if (!res.ok) throw new Error(`sourcify ${res.status}: ${JSON.stringify(body)}`);
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const job: any = await (await fetch(`${API}/v2/verify/${body.verificationId}`)).json();
  if (job.isJobCompleted) {
    if (job.error) throw new Error(`sourcify: ${JSON.stringify(job.error).slice(0, 600)}`);
    console.log(`verified: ${job.contract?.match ?? job.contract?.runtimeMatch} https://repo.sourcify.dev/${NETWORKS[net].chainId}/${address}`);
    process.exit(0);
  }
}
throw new Error('sourcify job did not finish');
