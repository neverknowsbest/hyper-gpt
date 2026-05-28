import { App } from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { AppStack } from "../lib/app-stack";

const app = new App();

// us-east-1 — Route53's home and where we keep everything. The account comes
// from the CDK CLI (set from resolved AWS credentials). fromLookup needs a
// concrete account, so fail early with an actionable message if it's missing.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error(
    "No AWS account resolved (CDK_DEFAULT_ACCOUNT is empty). Configure " +
      "credentials so the AWS SDK can find them — e.g. `aws sso login`, set " +
      "AWS_PROFILE, or your internal cred tool — then verify with " +
      "`aws sts get-caller-identity` and re-run.",
  );
}
const env = { account, region: "us-east-1" };

const domainName = app.node.tryGetContext("domainName") as string;
const repoUrl = app.node.tryGetContext("repoUrl") as string;

// VPC lives on its own. The app stack finds it by tag (Vpc.fromLookup), so
// there's no cross-stack construct reference / CFN export between them.
// First deploy is two-phase: deploy the network stack before the app stack
// synthesizes (see docs/deployment.md).
new NetworkStack(app, "HyperGptNetwork", { env });

new AppStack(app, "HyperGptApp", { env, repoUrl, domainName });
