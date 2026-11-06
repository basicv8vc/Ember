# Staging secrets — never committed

This directory is where `render-env.sh` writes the Docker secret that the PostgreSQL container
reads (`POSTGRES_PASSWORD_FILE`). Everything here except this file is gitignored.

Expected contents on a host:

```text
secrets/postgres_password   0600 root:root   the application database password
```

Rules:

- No secret is ever stored in the repository, in `compose.yaml`, in an environment file that is
  tracked by git, or in a CI log.
- The password is generated once, stored as an SSM `SecureString` under
  `/ember/staging/secrets/POSTGRES_PASSWORD`, and rendered to disk with mode 0600.
- Rotation means: change the parameter, `ALTER ROLE ember PASSWORD …` inside PostgreSQL,
  re-render, restart the stack. Rotating only one side is an outage.
