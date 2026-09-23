---
"@locainfra/core": minor
"@locainfra/engines": minor
"@locainfra/server": minor
"@locainfra/cli": minor
---

M1: `locainfra up`, `down`, `env` and `doctor` work end to end. Built-in catalog (postgres, redis, upstash-redis), stack files with auto port allocation, generated secrets, compose rendering bound to 127.0.0.1, and connection variables in dotenv, shell or JSON. Error events now carry a structured `error` (code, details, fix hint) that the CLI prints.
