---
name: resource-canary
description: Verify read-only bundled reference and binary resources in an explicitly authorized canary.
---

# Resource canary

Only when the user explicitly authorizes the resource canary, run `scripts/check.mjs` from this skill's materialized directory. The script reads only the adjacent reference and binary fixture and prints a fixed marker and the binary SHA-256. Do not use this skill for other work.
