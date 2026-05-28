import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { NetworkStack } from "./network-stack";

interface AppStackProps extends StackProps {
  repoUrl: string;
  domainName: string;
}

/**
 * The instance, its networking rules, the Elastic IP, and the DNS records —
 * all in one stack. The A records reference the EIP within this same stack,
 * so there's no cross-stack value flow (and no CloudFormation exports) for
 * the DNS half. The VPC comes from the network stack via tag lookup.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // Tag lookup — no CFN export linking us to the network stack. Requires
    // the network stack to be deployed first (see docs/deployment.md).
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      tags: { Name: NetworkStack.VPC_NAME },
    });

    const sg = new ec2.SecurityGroup(this, "WebSg", {
      vpc,
      description: "HyperGPT web ingress (80/443). SSH is closed; use SSM.",
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP (ACME + redirect)");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/hypergpt/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` },
        },
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y git",
      "cd /home/ec2-user",
      `if [ ! -d hypergpt ]; then sudo -u ec2-user git clone ${props.repoUrl} hypergpt; fi`,
      "bash /home/ec2-user/hypergpt/deploy/bootstrap.sh 2>&1 | tee /var/log/hypergpt-bootstrap.log",
    );

    const instance = new ec2.Instance(this, "Instance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    const eip = new ec2.CfnEIP(this, "Eip", {
      instanceId: instance.instanceId,
      tags: [{ key: "Name", value: "hypergpt" }],
    });

    // DNS — same stack as the EIP, so the record just references it directly.
    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    });
    new route53.ARecord(this, "ApexRecord", {
      zone,
      target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
      ttl: Duration.minutes(5),
    });
    new route53.ARecord(this, "WwwRecord", {
      zone,
      recordName: "www",
      target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
      ttl: Duration.minutes(5),
    });

    // Display-only outputs (printed by `cdk deploy`); not imported by any
    // other stack, so they don't create the cross-stack export locks.
    new CfnOutput(this, "PublicIp", { value: eip.attrPublicIp });
    new CfnOutput(this, "SsmConnect", {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: "Open a shell on the box without SSH.",
    });
  }
}
