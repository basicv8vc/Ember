# Ember Cloud Staging — Resources and Permissions Needed

> **Not the Issue #131 deployment path.** That task uses the existing host and a Cloudflare
> Named Tunnel; see [CLOUD-STAGING-CLOUDFLARE-TUNNEL.md](./CLOUD-STAGING-CLOUDFLARE-TUNNEL.md).
> AWS remains an option for future scale, but any paid resources require prior approval. The
> domain owner must explicitly authorize the existing domain, Cloudflare account and staging
> DNS change before a public route can be created.

Nothing in this list has been created. This document records an earlier AWS proposal. Under
the current CTO direction, any new paid resource requires prior approval; the Cloudflare
Tunnel task separately requires the domain owner to authorize the account and DNS change.

Everything below is **staging only** and is deliberately independent of the Shua estate: a
separate AWS account or at minimum a separate VPC, separate credentials, separate database,
separate SSM tree.

---

## 1. Required to bring staging online

| #   | Resource             | Specification                                                                                                                                                            | Why                                                                                                         | Monthly cost (rough)                        |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | EC2 instance         | `t3.small` (2 vCPU, 2 GiB), Ubuntu 24.04 LTS, 20 GiB gp3 root                                                                                                            | Runs the four containers                                                                                    | ~$18                                        |
| 2   | Elastic IP           | 1 address, associated                                                                                                                                                    | Stable A record across stop/start                                                                           | ~$3.6 (when attached, free in some regions) |
| 3   | Security group       | inbound `443/tcp` from `0.0.0.0/0`; `80/tcp` from `0.0.0.0/0`; `22/tcp` from the operator CIDR only                                                                      | HTTPS + ACME + admin SSH; no other inbound port                                                             | $0                                          |
| 4   | SSM Parameter Store  | 1 SecureString + ~3 String parameters under `/ember/staging/`                                                                                                            | Configuration and the database password; no secret in git                                                   | $0                                          |
| 5   | IAM instance profile | `ssm:GetParametersByPath`, `ssm:GetParameter`, `ssm:PutParameter` scoped to `/ember/staging/*`; SSM Session Manager for shell access (replaces inbound SSH if preferred) | Pull configuration at boot without static keys                                                              | $0                                          |
| 6   | EBS snapshot policy  | daily snapshot of the instance volume, 7-day retention                                                                                                                   | Recover the database volume                                                                                 | ~$1–2                                       |
| 7   | Domain + DNS record  | one hostname under a domain the project already controls, e.g. `staging.ember-cloud.net` → the Elastic IP                                                                | Required for a certificate an iPhone will trust; Let's Encrypt does not issue for `*.compute.amazonaws.com` | $0 if the domain exists                     |
| 8   | Budget alarm         | AWS Budgets alarm at a low threshold on the staging account                                                                                                              | Staging must not surprise anyone                                                                            | $0                                          |

Total, order of **$25/month** plus storage. No managed database, no load balancer, no NAT
gateway, no container registry (images are built on the host for now).

## 2. Permissions requested for the deployer

To execute the runbook without further approval, the deploying identity needs:

```
ec2:RunInstances, ec2:CreateSecurityGroup, ec2:AuthorizeSecurityGroupIngress,
ec2:AllocateAddress, ec2:AssociateAddress, ec2:CreateVolume, ec2:CreateSnapshot,
ec2:DescribeInstances, ec2:DescribeSecurityGroups
iam:PassRole                      (only for the instance profile above)
ssm:GetParametersByPath, ssm:GetParameter, ssm:PutParameter   (scoped to /ember/staging/*)
ssm:StartSession                  (optional: shell access without SSH)
route53:ChangeResourceRecordSets  (only if the hosted zone is in the same account)
```

Not requested, and not used by this design: `rds:*`, `ecs:*`, `eks:*`, `elbv2:*`,
`ecr:*`, `secretsmanager:*`, `acm:*`, any write to an existing production account.

## 3. Decisions needed before go-live

| Decision            | Options                                                  | Default if unanswered                                        |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Account             | new AWS account, or an isolated VPC in an existing one   | new account                                                  |
| Hostname            | a subdomain of an existing domain, or a new registration | cannot proceed without one; ACME has no IP-based alternative |
| Operator SSH source | corporate CIDR, or Session Manager only                  | Session Manager only (no inbound 22)                         |
| Apple bundle id     | must equal the iOS app's bundle id                       | `com.basicv8vc.ember`, as configured in the iOS Xcode target |
| Budget cap          | monthly ceiling for the budget alarm                     | $50                                                          |

## 4. What is needed from the iOS side

Nothing blocking, but for the first device test:

1. A development build whose base URL is configurable (or a build pointed at the staging
   hostname), per [CLOUD-STAGING-CLIENT-INTEGRATION.md](./CLOUD-STAGING-CLIENT-INTEGRATION.md).
2. One Apple identity token produced by a real device sign-in, so the end-to-end
   authentication path can be exercised against staging. The deployment can verify that the
   verifier rejects bad tokens today; it cannot mint a good one.

## 5. Cost control built into the configuration

- No model provider credential exists in the staging environment, and the preflight guard
  treats one as a violation. Staging cannot bill a model call.
- No E2B credential exists for the same reason; the sandbox vendor stays off.
- The autonomous scheduler is disabled, so no background workload can grow on its own.
- The database is a container on the same host: no managed-database minimum spend.
- Logs are capped at 5 × 10 MB per container, which bounds disk growth.

## 6. After approval, in order

```sh
# 1. instance + security group + elastic IP  (console, Terraform or aws cli — all equivalent)
# 2. DNS record at the chosen hostname → elastic IP
# 3. on the host, as root:
install -d -m 0700 /etc/ember /etc/ember/secrets
git clone https://github.com/basicv8vc/Ember.git /opt/ember && cd /opt/ember
git checkout <release-commit>
infra/staging/scripts/render-env.sh --output=/etc/ember/staging.env
infra/staging/scripts/migrate.sh --env-file=/etc/ember/staging.env --confirm --verify-idempotent
infra/staging/scripts/deploy.sh --env-file=/etc/ember/staging.env
```

The deploy finishes by running the smoke suite; if it passes, the API is reachable at
`https://<hostname>` and the acceptance smoke in
[CLOUD-STAGING-VERIFICATION.md](./CLOUD-STAGING-VERIFICATION.md) §7 can be repeated against the
real host.
