import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";

interface DnsStackProps extends StackProps {
  domainName: string;
  /** Elastic IP from the compute stack. */
  ipAddress: string;
}

export class DnsStack extends Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    // The hosted zone already exists (domain registered in Route53).
    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    });

    // Apex A record → Elastic IP. (Apex can't be a CNAME, so A-to-IP is
    // the right call for a self-managed EIP.)
    new route53.ARecord(this, "ApexRecord", {
      zone,
      target: route53.RecordTarget.fromIpAddresses(props.ipAddress),
      ttl: Duration.minutes(5),
    });

    // www → same IP, for people who type it.
    new route53.ARecord(this, "WwwRecord", {
      zone,
      recordName: "www",
      target: route53.RecordTarget.fromIpAddresses(props.ipAddress),
      ttl: Duration.minutes(5),
    });
  }
}
