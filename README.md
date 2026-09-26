# anyCMS

```
                    ____ __  __ ____
  __ _ _ __  _   _ / ___|  \/  / ___|
 / _` | '_ \| | | | |   | |\/| \___ \     pick your cms. start building.
| (_| | | | | |_| | |___| |  | |___) |
 \__,_|_| |_|\__, |\____|_|  |_|____/     wordpress · astro · next.js · flask
             |___/                        mit · railway-ready · ai-connected
```

Four production-ready blogs, one for each stack you might already be on. Deploy
one, point it at an AI content pipeline, and articles publish themselves.

```console
$ pick your stack          wordpress · astro · next.js · flask
$ deploy                   one dockerfile, one volume, two keys
$ approve an article       in visibly
  → POST /webhook          signed, verified, 202 in 30ms
  ✓ /guides/your-article   live, indexed, in your rss feed
```

---

## Pick your CMS

| Stack | What you get | Setup |
|---|---|---|
| **[WordPress](apps/wordpress)** | One plugin, posts land in your existing site | Upload a PHP file |
| **[Astro](apps/astro)** | Full SEO blog with admin UI, search, i18n | Deploy |
| **[Next.js](apps/nextjs)** | App Router blog, server-rendered, no framework CSS | Deploy |
| **[Flask](apps/flask)** | The same blog in Python, Jinja templates | Deploy |
| **[Your own](docs/CONTRACT.md)** | The protocol, in ~50 lines of any language | Read the contract |

Every one of them ships with: SEO metadata, Open Graph, JSON-LD structured
data, canonical URLs, RSS, XML sitemap, robots.txt, categories, tags, full-text
search, pagination, reading time, related posts, table of contents and dark
mode. Not a skeleton to fill in.

Powered by [Visibly AI](https://app.visibly-ai.com).

---

## Start building

> **Requirement:** a Visibly account on the **Standard plan or higher**. The
> connector pulls articles that the Content Autopilot writes, and the Autopilot
> (including the CMS connection and the project API key) is not part of the
> Free plan. Pick a plan under [Settings](https://app.visibly-ai.com/settings)
> before step 1, otherwise step 4 answers with 403.

### 1. Get your keys (2 minutes)

Everything happens on one page in Visibly.

1. [Register](https://app.visibly-ai.com/register) or
   [sign in](https://app.visibly-ai.com/login), then
   [create a project](https://app.visibly-ai.com/onboarding) for your site if
   you have none yet.
2. Open [Content Tools](https://app.visibly-ai.com/tools/content), pick your
   project and click **Content Autopilot**. The page is
   `https://app.visibly-ai.com/tools/content/autopilot/<project-id>`; scroll to
   the card **CMS access** (*CMS-Zugänge*).
3. Under **Contentpilot API key (Pull)** (*Contentpilot-API-Key (Pull)*) click
   **Create key** (*Key erzeugen*). Copy the key now, it starts with `cp_` and
   is shown exactly once. It only sees this project, which is what a connector
   should get. (An account-wide `lc_` key from
   [Settings > API key & MCP](https://app.visibly-ai.com/settings#api-key)
   works too, but it sees every project and needs the Pro plan.)
4. On the same page under **Add new access** (*Neuen Zugang hinterlegen*)
   create the connection:
   - **CMS type** (*CMS-Typ*): `Webhook (Pull-CMS)`
   - **Label** (*Bezeichnung*): any name
   - **Webhook URL** (*Webhook-URL*): your site plus the path from the table below
   - **Webhook secret** (*Webhook-Secret*): anything you like, you will paste
     it again in step 2
   - **Events**: tick `article.approved` and `article.updated`
   - **Save access** (*Zugang speichern*)
5. Once your connector is running (step 2), click **Test connection**
   (*Verbindung testen*) on the connection. Visibly sends a signed
   `webhook.test` event; green means URL and secret are right.

The Visibly UI is currently German; the italic words are the labels you will
see on screen.

| Stack | Webhook path |
|---|---|
| WordPress | `/wp-json/ai-automation/v1/webhook` |
| Astro, Next.js | `/api/visibly/webhook` |
| Flask | `/webhooks/visibly` |

### 2. Install

**WordPress**, no deployment needed:

1. Copy [`apps/wordpress/ai-automation-connector.php`](apps/wordpress/ai-automation-connector.php)
   into `wp-content/plugins/ai-automation-connector/`.
2. Activate it under Plugins.
3. **Settings > AI Automation**: paste the secret and the API key. The page
   shows the exact webhook URL to copy back into Visibly.

<a href="https://railway.com?referralCode=YKp8kE"><img src="https://railway.com/button.svg" alt="Deploy on Railway" height="40"></a>
<a href="https://railway.com?referralCode=YKp8kE"><img src="https://img.shields.io/badge/Railway-%2420%20free%20credit-6c47ff?logo=railway&logoColor=white&style=for-the-badge&labelColor=0B0D0E" alt="Railway: $20 free credit" height="40"></a>

**Astro, Next.js, Flask**, one Railway project each. Both buttons are the same
referral link, and signing up through it puts **$20 of Railway credit** on the
new account, roughly a free month on the Pro tier. Neither button deploys for
you: four apps live in this repo, and a one-click template covers exactly one.
Pick yours in step 2:

1. New project from this repo.
2. Set `RAILWAY_DOCKERFILE_PATH` to `apps/<stack>/Dockerfile`.
3. **Add a volume mounted at `/data`.** Railway's filesystem is otherwise
   ephemeral: new container, articles gone.
4. Set the variables below.

| Variable | Required | What it is |
|---|---|---|
| `VISIBLY_WEBHOOK_SECRET` | yes | The same secret as in the connection |
| `VISIBLY_API_KEY` | yes | `lc_…` or project-scoped `cp_…` |
| `SITE_URL` | yes | Your public base URL |
| `SITE_NAME` | no | Shown in the header and feeds |
| `SITE_DESCRIPTION` | no | Shown on the index and in the feed |
| `CONTENT_DIR` | no | Article directory (Next.js, Flask). Default `/data/content` |
| `POSTS_DIR` | no | Article directory (Astro). Default `/data/posts` |
| `POSTS_PER_PAGE` | no | Flask only. Default 10 |
| `DATABASE_URL` | no | Set it and articles go to Postgres instead of files |
| `ARTICLE_STORE` | no | `files` or `postgres`, overrides the line above |
| `ARTICLE_TABLE` | no | Postgres table name. Default `anycms_articles` |
| `VISIBLY_BASE_URL` | no | Only for self-hosted installations |

Flask also reads `CONTENTPILOT_WEBHOOK_SECRET`, the name its SDK expects. Set
both to the same value.

### 3. Approve an article in Visibly

It shows up on your site within seconds, in the right category, in the sitemap,
in the feed, and findable through search.

---

## What actually happens

```
Visibly: article approved
        │
        │  POST /webhook   (HMAC-SHA256 signed)
        ▼
   [1] verify signature          <- wrong? 401, done
   [2] answer 202 "accepted"     <- IMMEDIATELY, before doing any work
        │
        └── in the background:
            [3] GET /api/v1/articles/{id}    fetch the article
            [4] write it into your CMS
            [5] POST /articles/{id}/confirm  report the live URL back
```

**Step 2 is the one everybody gets wrong.** Visibly waits 10 seconds for your
response and does **not** retry when it times out, because the request already
reached you. If you answer only after the article is written, you get delivered
to repeatedly, doing the same work every time. For a CMS that translates
incoming articles, that is the same bill several times over.

This is not hypothetical. Measured in production on 2026-09-14: three delivery
attempts for one article turned into three LLM translation runs. Every
connector here acknowledges first and works afterwards, with a lock so a
repeated delivery is skipped instead of processed twice.

**Step 5 is what makes updates possible.** Until you report the URL back,
Visibly cannot target that post for later edits.

---

## Already have a CMS?

The connector is deliberately **one file**. Copy it, swap the storage call for
your own, keep everything else:

- **WordPress:** [`ai-automation-connector.php`](apps/wordpress/ai-automation-connector.php)
  is a complete plugin. Replace `aiac_upsert_post` to target a custom post type.
- **Astro:** [`webhook.ts`](apps/astro/src/pages/api/visibly/webhook.ts) plus
  [`visibly-storage.ts`](apps/astro/src/lib/visibly-storage.ts) work in any
  Astro project with `output: 'server'`.
- **Next.js:** [`route.ts`](apps/nextjs/app/api/visibly/webhook/route.ts).
  Node runtime is required; Edge cannot write files.
- **Python:** `pip install ai-content-autopilot`, register the blueprint. See
  [`apps/flask/app.py`](apps/flask/app.py).
- **Anything else:** [`docs/CONTRACT.md`](docs/CONTRACT.md) describes the whole
  protocol, with pseudocode for a minimal implementation.

All four implementations produce and accept the **same** HMAC signature,
verified across Node, PHP and Python including non-ASCII payloads.

---

## Where articles are stored

Your choice, decided by one environment variable.

| | Files (default) | Postgres |
|---|---|---|
| **How** | Markdown with frontmatter, one file per article | One table, schema created on first run |
| **Set up** | Mount a volume at `/data` | Set `DATABASE_URL` |
| **Pick it when** | You want readable, editable, git-friendly content | You run several instances, or want articles in the same backup as your data |
| **Catch** | A volume attaches to exactly one service | Articles are no longer plain files |

```bash
# Files (default): nothing to configure beyond the volume
CONTENT_DIR=/data/content

# Postgres: on Railway, adding a Postgres service sets this for you
DATABASE_URL=postgres://...

# Override, if a platform sets DATABASE_URL but you want files anyway
ARTICLE_STORE=files
```

The file format is the one Hugo, Jekyll, Eleventy and Astro content
collections use. Ghost, by the way, does not: it has a Markdown editor but
stores posts in MySQL.

**WordPress ignores both.** It writes real WordPress posts into the database it
already has, because that is what WordPress is.

**Astro uses files only.** Its template reads MDX from disk for search, RSS and
the admin UI; pointing that at Postgres would mean rewriting the template
rather than configuring it.

Both backends are held to the same behaviour by a test that runs the identical
sequence against each and compares the results
([`apps/flask/test_store.py`](apps/flask/test_store.py)). That test found a
real bug on its first run: the file parser mangled a title ending in a quoted
word, because stripping the outer quotes before unescaping eats the escaped
one.

The Astro starter is the
[astro-seo-blog-template](https://github.com/kevingabeci/astro-seo-blog-template)
(MIT, by Apatero) with the connector wired in. Two changes were necessary, both
marked `ANYCMS PATCH` in the source and explained in
[`apps/astro/NOTICE`](apps/astro/NOTICE): blog pages render on the server
instead of at build time, and the post directory became configurable. Without
the first, an article delivered at runtime would only appear after the next
deploy.

---

## Multilingual and hreflang

A Visibly article carries exactly **one** language; there is no translation
endpoint. Two ways to go multilingual:

1. **Your CMS translates.** You receive the source article and produce the
   other languages yourself. Slow by nature, which is exactly why the handler
   must not run inside the webhook request.
2. **One cluster per language.** Each Visibly cluster gets its own language,
   target country and path prefix. Articles then arrive with
   `content_language`, `target_country` and `url_prefix`, written natively in
   that language rather than translated, with keyword research per market.

**Visibly does not build URLs and emits no hreflang tags.** It ships slug,
prefix and language as the blueprint; the finished URL is yours, and you report
it back. So the tags are yours to render. Rules and pitfalls:
[`docs/CONTRACT.md`](docs/CONTRACT.md).

---

## Tested

```bash
cd packages/ai-automation-connector && npm install && npm run build && npm test
cd apps/astro     && npm install && npm run build && node test/e2e.mjs
cd apps/nextjs    && npm install && npm run build && node test/e2e.mjs
cd apps/flask     && pip install -r requirements.txt && python test_e2e.py
cd apps/wordpress && php test_signature.php
```

Against Postgres as well, with a throwaway container:

```bash
docker run -d --name anycms-pg -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=anycms_test -p 55432:5432 postgres:16-alpine
export PG=postgres://postgres:testpw@127.0.0.1:55432/anycms_test

cd packages/ai-automation-connector && TEST_DATABASE_URL=$PG npm run test:pg
cd apps/flask  && TEST_DATABASE_URL=$PG python test_store.py
cd apps/nextjs && DATABASE_URL=$PG node test/e2e.mjs
```

Each end-to-end test runs the real server, sends a signed webhook, answers from
a fake Visibly, and asserts that the response arrives in milliseconds, the
article lands on the page, and the URL is reported back. They also check the
blog around it: canonical URLs, JSON-LD, category and tag pages, RSS, sitemap,
robots, search index, pagination, and that the stylesheet actually ships.

That is not decoration. These tests caught, on their first run:

- a **prerendered blog** in the Astro template, which would have made every
  delivered article invisible until the next deploy
- a **wrong start path** in the Next.js Dockerfile: green build, dead container
- **missing CSS** in the Next.js standalone build: correct HTML, unstyled page
- a **500 error** in Flask from a Jinja macro imported without context
- a **mangled title** in the file parser, found only by running the same
  sequence against Postgres and comparing

---

## License

MIT. Use it, fork it, sell what you build with it.
