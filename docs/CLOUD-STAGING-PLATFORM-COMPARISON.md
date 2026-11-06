# Ember Cloud Staging — Platform Comparison

The task asked for EC2 first, "unless a faster and equally safe option exists". This is the
comparison that was promised, and it did not change the decision: EC2 + Docker Compose is the
chosen platform.

## Options considered

|                                            | **EC2 + Compose (chosen)**                    | ECS Fargate + RDS                                         | Lightsail Containers             | Fly.io / Render                           |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| Setup effort                               | low (one host, one compose file)              | high (cluster, task defs, ALB, RDS, VPC, secrets)         | medium                           | low                                       |
| Moving parts to secure                     | 1 host, 1 SG, 4 containers                    | ALB, target groups, task roles, RDS SG, secret policies   | 1 container service + managed DB | external platform account                 |
| PostgreSQL control                         | full (version, `pg_hba`, extensions, restore) | managed, constrained                                      | managed                          | managed, limited                          |
| Migration as an explicit step              | natural (`docker compose run migrate`)        | needs a separate task definition and scheduler discipline | needs a one-off job              | possible                                  |
| Cost at staging scale                      | ~$25/mo                                       | ~$90–120/mo (ALB + RDS floor)                             | ~$20–40/mo                       | ~$20–30/mo                                |
| Data residency / account control           | full                                          | full                                                      | full                             | third-party processor                     |
| Meets "no Shua resources, separate estate" | yes                                           | yes                                                       | yes                              | yes, but on someone else's infrastructure |
| Runs the existing Dockerfile unchanged     | yes                                           | yes (image push required)                                 | yes (image push required)        | yes (image push required)                 |
| Failure modes we would own                 | host disk, host reboot, manual backup         | many, but managed                                         | fewer                            | fewest                                    |

## Why EC2 won

1. **The security model is small enough to review.** Four containers, two networks, one
   published HTTP port. Every requirement in the task maps to a line in `compose.yaml` that a
   reviewer can read in a minute.
2. **The database stays under our control.** The acceptance criteria include migration
   idempotency and restart durability; a container-local PostgreSQL 17 makes both trivially
   reproducible and lets `pg_hba` be exactly what the design says it is.
3. **Migrations stay a human decision.** `docker compose run --rm migrate` is an explicit,
   auditable act. On ECS the same property needs a separate task definition plus the
   discipline not to wire it into a deploy pipeline.
4. **No new artifact pipeline is required.** Fargate/Lightsail/Fly all require a registry and a
   push step before anything can start; on EC2 the images are built from the same lockfile the
   tests use.
5. **Cost.** Staging at ~$25/month instead of ~$100/month, with no ALB or managed database to
   justify.

## What would change the decision

- **Multiple concurrent testers or a need for zero-downtime deploys** → ECS Fargate + RDS,
  because a single host means a single point of failure and a restart window.
- **A compliance requirement that the database be managed and point-in-time recoverable** →
  RDS, accepting the cost and the loss of direct `pg_hba` control.
- **A requirement to reach the API from devices without managing a domain** → a platform with
  a managed hostname (Fly/Render), accepting a third-party data processor.

None of these are true today. The deployment is structured so the move is a compose file and
an image-push step, not a rewrite: the application containers are platform-agnostic, they take
all configuration from the environment, and they never assume the host filesystem beyond one
blob volume.
