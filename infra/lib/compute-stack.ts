import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";

interface ComputeStackProps extends StackProps {
  repoUrl: string;
}

export class ComputeStack extends Stack {
  /** The Elastic IP address, consumed by the DNS stack for the A record. */
  public readonly publicIp: string;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

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
        // Enables SSM Session Manager (no SSH/port 22 needed).
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    // Read (and KMS-decrypt) /hypergpt/* SSM parameters — the Anthropic key
    // lives at /hypergpt/anthropic-api-key as a SecureString that you create.
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
    // SecureString decryption uses the account's default SSM KMS key.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
          },
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
    this.publicIp = eip.attrPublicIp;

    new CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new CfnOutput(this, "PublicIp", { value: eip.attrPublicIp });
    new CfnOutput(this, "SsmConnect", {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: "Open a shell on the box without SSH.",
    });
  }
}
