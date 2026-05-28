import { App } from "aws-cdk-lib";
import { ComputeStack } from "../lib/compute-stack";
import { DnsStack } from "../lib/dns-stack";

const app = new App();

// us-east-1 — Route53's home and where we keep everything.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "us-east-1",
};

const domainName = app.node.tryGetContext("domainName") as string;
const repoUrl = app.node.tryGetContext("repoUrl") as string;

const compute = new ComputeStack(app, "HyperGptCompute", {
  env,
  repoUrl,
});

// DNS lives in its own stack so record changes are decoupled from compute
// redeploys. It consumes the Elastic IP produced by the compute stack.
new DnsStack(app, "HyperGptDns", {
  env,
  domainName,
  ipAddress: compute.publicIp,
});
