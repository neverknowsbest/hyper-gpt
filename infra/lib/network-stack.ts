import { Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

/**
 * The VPC, in its own stack so it's described-in-code (not the account's
 * default), cleanly destroyable, and rarely touched.
 *
 * Public-only with zero NAT gateways: the web server lives in a public
 * subnet behind an Elastic IP and reaches the internet (Anthropic, ACME,
 * SSM, package installs) straight through the Internet Gateway. A NAT
 * gateway would cost ~$32/mo each and we have no private subnets that
 * would need one.
 *
 * The app stack finds this VPC via `Vpc.fromLookup({ tags: { Name } })`
 * rather than a cross-stack construct reference, so there are no
 * CloudFormation exports linking the two stacks.
 */
export class NetworkStack extends Stack {
  static readonly VPC_NAME = "hypergpt";

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    Tags.of(vpc).add("Name", NetworkStack.VPC_NAME);
  }
}
