# Agent Runbook: Install a Visibly Connector on Any Host

Use this runbook when an agent connects a website or CMS to Visibly Content Autopilot. It applies to this repository's starters and custom integrations on Vercel, Railway, Hetzner, or another host.

The protocol contract is in [CONTRACT.md](CONTRACT.md). The contract defines the wire behavior; this runbook defines the installation and verification workflow.

## Non-negotiable rules

- Inspect the repository, current Git changes, deployment setup, and existing storage before editing. Preserve user changes and follow repository instructions.
- Do not assume the host from the framework. A Next.js site may run on Vercel, Railway, or a VM. Detect the actual deployment target from project files and provider configuration.
- Never ask the user to paste secrets into chat. Never print secrets in logs, command output, reports, screenshots, source files, or commits. Use the host's secret manager or have the user enter the value directly in its UI or terminal prompt.
- Keep credentials separate: `VISIBLY_WEBHOOK_SECRET` authenticates incoming webhooks; `VISIBLY_API_KEY` authorizes Pull API requests; a GitHub token is only needed when the chosen storage writes to GitHub. Use a project-scoped `cp_` key when possible.
- Do not claim setup is complete until the deployed endpoint, signature check, Pull API access, storage, and confirmation path have been tested.
- Do not approve or publish a real production article as a test unless the user explicitly approves that action.

## MCP capability boundary

The published Visibly MCP can read project and content data and can create or update article drafts with revision protection. It does not currently create CMS connections, set webhook URLs or secrets, issue project API keys, set hosting environment variables, approve articles, or publish to a CMS. `update_article` is limited to `draft` and `rejected` articles and selected fields.

Therefore, an agent must not say it configured the webhook or secret through MCP. Create the CMS connection in Visibly's Content Autopilot UI unless a dedicated, authorized setup tool is available. Configure host secrets through that provider's secret manager. A separate provider MCP may help only after the user has authorized it and the tool's actual permissions are verified.

## 1. Inspect and choose storage

Before changing code, record these facts from the repository and provider configuration:

1. Framework, runtime, and existing webhook or API route.
2. Actual host, deployment method, public site URL, and how environment variables are managed.
3. Whether the process is persistent, serverless, or static-only.
4. Where articles will persist and how the live site will serve them.
5. The deployment, restart, health-check, and log commands for this specific project.

A static build cannot see files written after the build. Choose one storage path before implementing:

- **Git-backed content:** commit files through a narrowly scoped repository token and let the normal deployment rebuild the site.
- **Database or external CMS:** persist there and make sure the site renders or fetches the new content at runtime.
- **Persistent filesystem:** use only when the host provides a durable volume and the application reads from that mounted path.

Never store runtime articles on an ephemeral function/container filesystem and assume they will survive a restart.

Ask the user only for decisions that cannot be discovered safely, such as the desired public URL or storage destination. Do not ask them to choose a runtime architecture before inspecting the project.

## 2. Choose the request and background-work model

The endpoint must respond within Visibly's delivery timeout. Select the model from the work duration and host guarantees, not from framework convention.

| Hosting model | Safe default |
|---|---|
| Serverless functions, such as Vercel or Netlify | Finish the complete operation inside the request if it reliably fits the deadline. Otherwise durably enqueue it before returning `202`, then process it in a separate worker. |
| Cloudflare Workers | Use `ctx.waitUntil()` only for bounded work that fits its lifetime limit. For HTTP-triggered Workers, `waitUntil()` is limited to 30 seconds after invocation end; longer work belongs in a Queue consumer. |
| Persistent service, such as Railway or a Hetzner VM | Acknowledge with `202` only after a durable queue/job record is committed. Run a worker that survives request completion and process restarts. |
| Static-only site | Add a serverless endpoint and an external durable store, or commit to Git and rebuild. Static output alone cannot persist or render a newly received article. |

`waitUntil()` extends an execution context; it is not a durable job queue. Vercel work remains bounded by the function's configured `maxDuration`. A detached promise, background thread, or in-memory queue is not proof that a job will finish.

For short work, respond only after the article is stored and return `200` with the resulting ID/URL expected by the contract. For queued work, respond `202` only after the durable enqueue succeeds. Never send `202` first and then start untracked work.

## 3. Implement the protocol

Follow [CONTRACT.md](CONTRACT.md) and the matching starter implementation. At minimum:

- Read and verify the exact raw request bytes with HMAC-SHA256 before parsing JSON. Use a constant-time signature comparison.
- Reject missing or invalid signatures with `401`. Do not log the secret, signature, API key, or full credential-bearing environment.
- Handle `webhook.test` before any article lookup. It has no `article_id`; answer `200` with `{"status":"ok","event":"webhook.test"}` and do not call the Pull API.
- Handle only supported article events (`article.approved`, `article.updated`, and `article.published`). Log and acknowledge unsupported notifications without attempting to fetch a missing article.
- Fetch article data from Visibly using `VISIBLY_API_KEY`. Do not trust article content or slugs as filesystem paths; validate and normalize paths before writing.
- Make processing idempotent by article ID and revision or another durable event key. A retry must not create duplicate posts or commits.
- Persist the article before calling the Visibly confirm endpoint. Confirm only the URL that the CMS can actually serve.
- Keep the content format (`html` or `markdown`) intact. Do not render HTML as Markdown or vice versa.

Use the contract's response table for status codes. Do not turn a successful `webhook.test` into an article fetch or treat an unsupported event as a retryable server failure.

## 4. Configure Visibly and secrets

The current MCP cannot perform this setup. Use the Visibly UI:

1. Select the correct project in **Content Autopilot**.
2. Create a project-scoped Contentpilot Pull API key. Copy it once; it is the value for `VISIBLY_API_KEY`.
3. Generate a separate random webhook secret locally or in an approved password manager. Do not reuse the API key.
4. Create a **Webhook (Pull-CMS)** access with the deployed endpoint URL, the same webhook secret, and the required events (`article.approved` and `article.updated`, plus `article.published` if the integration handles it).
5. Put `VISIBLY_API_KEY` and `VISIBLY_WEBHOOK_SECRET` in the host's secret manager. The webhook secret must match the value saved in the Visibly connection exactly.
6. If storage commits to GitHub, create a separate least-privilege token for only that repository and store it as a host secret. Do not create a GitHub token when the selected storage does not need one.

The secret may be submitted once to the Visibly connection form and once to the hosting secret manager, but never echoed back in a completion report. The connection list should expose only a boolean such as `has_webhook_secret`, never the stored value.

## 5. Apply provider-specific installation steps

Use only the branch that matches the host actually detected. Do not run commands for multiple providers.

### Vercel

- Put the handler in the project's supported API route and use the Web `Request` API to read `await request.text()` before parsing.
- Store articles in Git, a database, or an external CMS. Do not write to the function's local filesystem.
- Add environment variables in the correct Vercel environment. Redeploy after changing them; existing deployments do not acquire new values.
- Check the configured `maxDuration`. Use synchronous processing only when the full path fits comfortably inside Visibly's timeout; otherwise use a durable queue and a separate consumer.

### Railway

- Identify the correct service and Dockerfile/start command. Do not assume the web service is also the worker.
- Add secrets as Railway service variables. Use a persistent volume or database for article storage; the container filesystem is ephemeral.
- Deploy/restart the service after configuration changes and verify the health check and logs for that deployment.

### Hetzner or another VM/container host

- Identify the actual service manager (for example, Docker Compose or systemd), reverse proxy, TLS termination, and persistent data path.
- Use the provider's secret mechanism or a root-owned environment file with restrictive permissions. Never commit the file or expose it through a web root.
- Restart the correct service after changing configuration. Verify HTTPS, firewall routing, service health, and persistent storage.

### Any other host

Inspect that provider's current deployment and secret-management mechanism. Give the user exact commands for the detected project, not generic placeholders presented as executable commands. If the provider's runtime or persistence guarantees are unclear, stop and ask before deploying.

## 6. Verify from outside

Run the project's tests and build first. Then verify the deployed endpoint using harmless checks:

1. `GET <webhook-url>` returns the documented method response (commonly `405`), not `404`.
2. Visibly's signed **Test connection** event returns `200` and `status: ok`.
3. A deliberately invalid signature returns `401` and does not reach the handler.
4. With the project key, a read-only Pull API request succeeds. Never include the key in terminal output or screenshots.
5. Verify the chosen store can persist and serve content. Use a staging project, test record, or approved draft and clean it up afterward.
6. Deliver the same test event twice and verify idempotency. Confirm that the URL reported to Visibly resolves to the stored article.

Do not publish an unapproved production article to prove the connector works. If only the `webhook.test` path was exercised, report that article delivery remains unverified.

## 7. Handover

Report, in plain language:

- Hosting provider, deployed URL, and webhook URL.
- Storage choice and whether it survives redeploy/restart.
- Build/test results and the exact external checks that passed or failed.
- Which values were configured, by variable name only. Never include their values.
- Anything the user still needs to do in Visibly, the host dashboard, or the provider account.
- The MCP boundary: list any setup action that MCP could not perform. Never describe a UI step as completed unless it was actually verified.
