# Dashboard integration seam

`registerDashboardAssets(app)` registers the read-only `/dashboard` shell and
the two compiled browser modules. The server owns data and authentication:

- `GET /api/works?limit=100&cursor=...` returns a `ListPage<WorkSummary>`;
  `title` is an exact filter and `ancestor=<work-ref>` includes that Work and
  all descendants.
- `GET /api/teammates?limit=100&cursor=...` returns a `ListPage<TeammateSummary>`.
- Every `ListPage` includes `total_count` for the complete filtered result,
  in addition to `items` and `next_cursor`.
- `GET /api/entity/:ref` returns the complete Work (including its Living Doc)
  or complete Teammate (including Teammate Memory).

The client starts with an unlock screen and posts the entered password to the
same-origin session endpoint. The server returns an eight-hour,
stateless `HttpOnly; SameSite=Strict` cookie containing only a versioned expiry,
random nonce, and HMAC signature. The signing key is derived from
`DASHBOARD_PASSWORD` with a domain-separated context, so replicas configured
with the same password can verify it without shared session storage. The
password is not stored in browser JavaScript, browser storage, URLs, cookies,
or the page source. Restarting the service does not invalidate an otherwise
valid cookie; rotate `DASHBOARD_PASSWORD` if a cookie is stolen. Logout only
clears the current browser's cookie.
The asset routes may be registered behind the same dashboard authentication
policy as the shell.
