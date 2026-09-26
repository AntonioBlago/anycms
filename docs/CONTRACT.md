# The contract

Everything you need to connect a CMS that is not in this repo. Roughly 50 lines
of work in any language.

## Events

| Event | When | What to do |
|---|---|---|
| `webhook.test` | "Test connection" was clicked in Visibly | Answer `200`; nothing to fetch |
| `article.approved` | An article was approved | Create the post |
| `article.updated` | An already published article changed | Overwrite the existing post |
| `article.published` | A publication was confirmed | Usually nothing |
| `article.failed` | Generation failed | Log it |

`webhook.test` is the first event any integrator ever receives, and it carries
**no `article_id`**. Handle it before any code path that needs one, and answer
it deliberately: a generic "unknown event" reply reads as *accepted but nothing
happened*, which is indistinguishable from a broken connector.

The payload:

```json
{
  "event": "article.updated",
  "article_id": 42,
  "title": "Nice class 25",
  "slug": "nice-class-25",
  "project_id": 5,
  "scheduled_date": null,
  "published_url": "https://example.com/glossary/nice-class-25",
  "revision": 3,
  "pull_url": "https://app.visibly-ai.com/api/v1/articles/42",
  "timestamp": "2026-09-14T10:00:00Z"
}
```

`published_url` and `revision` only come with `article.updated`. The URL lets
you find the existing post even if you never stored the Visibly ID; the
revision lets you skip a state you already have.

**The payload does not contain the article text.** It is the signal; the text
comes from the pull API.

## Signature

Every webhook carries `X-Webhook-Signature: sha256=<hex>`, an HMAC-SHA256 over
the **raw body** using the connection's secret.

Two traps that regularly cost hours:

1. **Verify against the bytes you received, not re-serialized JSON.** A
   `JSON.parse` followed by `JSON.stringify` changes key order and whitespace,
   and every valid signature fails.
2. **Compare in constant time** (`timingSafeEqual`, `hmac.compare_digest`,
   `hash_equals`). A plain `==` on strings stops at the first wrong character
   and leaks, through timing, how far an attacker got.

```python
# Python
import hashlib, hmac
expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected, header.removeprefix("sha256="))
```

```php
// PHP
$expected = hash_hmac('sha256', $rawBody, $secret);
$ok = hash_equals($expected, str_starts_with($h, 'sha256=') ? substr($h, 7) : $h);
```

```js
// Node
const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
const given = header.startsWith('sha256=') ? header.slice(7) : header;
const ok = given.length === expected.length
  && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
```

All three produce the same hex, including for non-ASCII payloads. This repo
tests that across the three languages.

## Responses: what Visibly reads into them

| Your response | How Visibly reads it |
|---|---|
| `202` | Accepted, you are working on it. Success. |
| `200` with `blog_post_id`, `post_id` or `id` in the body | Processed, done. |
| `200` with JSON naming none of those | Accepted but nothing happened. Logged as a failure, with your message. |
| `4xx` | Rejected. No retry, a second attempt would fail the same way. |
| `5xx`, `429` | Transient. Retried after 1s, 5s, 25s. |
| No response within 10s | Delivered, outcome unknown. **No retry.** |

The last row is the reason for the whole design. A read timeout does not mean
"did not arrive", it means "the request was there, the answer is missing".
Sending again would trigger the same work a second time.

**A failure inside your handler is not a `5xx`.** The delivery worked, the work
did not. A `5xx` invites a retry that reproduces the same error. Log it and
return `202`.

### Serverless: where "answer first, work later" needs help

The pattern above assumes a process that outlives the response. On Vercel,
Netlify Functions and Cloudflare Workers it does not: the instance is frozen or
torn down the moment the response is sent. A floating promise or a daemon thread
is truncated mid-flight. The sender sees its `202`, the article never lands, and
**nothing is logged** - the worst failure mode there is, because every signal
says success.

Two ways out, and which one applies depends on how long the work takes:

- **Use the platform's continuation primitive.** `waitUntil` (Vercel via
  `@vercel/functions`, Cloudflare via `ExecutionContext`) keeps the instance
  alive after the response. Required if the work is slow - translation, image
  generation, anything with an LLM in it.
- **Do the work inside the request.** If fetching, storing and confirming take a
  few seconds - the normal case for a file or database write - run them before
  answering and return `200` with an `id`. Give the whole chain one shared
  deadline (`AbortSignal.timeout`) so a slow upstream cannot push you past the
  10 second mark.

What does *not* work is the middle ground: firing the work off and returning
immediately without a continuation primitive.

One more platform detail, same family of problem: **read the raw body
yourself.** Several runtimes parse the request body for you, and a body that has
been through `JSON.parse` and `JSON.stringify` no longer matches its own
signature. On Vercel's Node runtime that rules out the `(req, res)` handler in
favour of the Web signature, where `await request.text()` returns the bytes as
sent:

```js
export async function POST(request) {
  const raw = await request.text();   // exact bytes, safe to HMAC
}
```

## Pull API

Base `https://app.visibly-ai.com`, auth `Authorization: Bearer <key>`.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/articles?status=approved&limit=20` | List approved articles |
| `GET /api/v1/articles/{id}?include_markdown=true` | One article with content |
| `POST /api/v1/articles/{id}/confirm` | Report publication: `{"published_url": "…"}` |

Two kinds of key at the same gate: `lc_…` is account-wide, `cp_…` is bound to
one project and only ever sees that project's articles.

### Fields that matter for routing

| Field | Meaning |
|---|---|
| `slug` | URL part of the post. **Visibly does not build the URL**, you do. |
| `url_prefix` | Path prefix of the cluster, e.g. `/glossary/`. `null` = no cluster. |
| `content_language` | Language of the cluster (`de`, `en`). `null` = no cluster, **not** "English". |
| `target_country` | Target country of the cluster (`DE`, `US`). |
| `recommended_page_type` | Template hint (`guide`, `blog`, …). |
| `content_format` | `html` or `markdown`. Both occur, check it. |
| `revision` | Increases on every write in Visibly. |

## Multilingual and hreflang

**A Visibly article carries exactly one language.** There is no translation
endpoint and no article with several language versions.

### Option A: your CMS translates

You receive the source article and produce the other languages yourself. You
own the cost, the glossary and the consistency; Visibly sees one article, and a
later `article.updated` overwrites your source language.

That is slow by nature, and precisely why translation must not run inside the
webhook request.

### Option B: one cluster per language

Each Visibly cluster gets its own language, target country and path prefix:

| Cluster | `content_language` | `target_country` | `url_prefix` |
|---|---|---|---|
| Glossary DE | `de` | `DE` | `/glossar/` |
| Glossary EN | `en` | `US` | `/en/glossary/` |
| Glossary FR | `fr` | `FR` | `/fr/glossaire/` |

Every article is written natively in its language rather than translated, with
keyword research per market. The price: one article per language against your
monthly quota.

### The hreflang structure is yours to build

Visibly ships `slug`, `url_prefix` and `content_language` as the blueprint. The
finished URL happens at your end, and you report it back with `confirm`. So the
tags belong to you:

```html
<link rel="alternate" hreflang="de" href="https://example.com/glossar/nizza-klasse/">
<link rel="alternate" hreflang="en" href="https://example.com/en/glossary/nice-class/">
<link rel="alternate" hreflang="fr" href="https://example.com/fr/glossaire/classe-de-nice/">
<link rel="alternate" hreflang="x-default" href="https://example.com/en/glossary/nice-class/">
```

Three rules generators get wrong more often than not:

1. **Every version links every version, including itself.** A page missing its
   own hreflang counts as an incomplete set and gets ignored.
2. **`x-default` points at the version for visitors none of the others fit**,
   usually the English one. It is not "the site's default language".
3. **Only link pages that exist and are indexable.** An hreflang pointing at a
   `noindex` page or a 404 invalidates the whole set.

**What Visibly does not tell you yet:** which articles are translations of one
another. Two clusters deliver two independent articles with no linking
identifier. Keep that mapping on your side, for example the cluster pair plus
your own topic key.

## Security

- **Slug and `url_prefix` come from an external system and end up in a path.**
  Without validation, a `../` writes outside your content directory. The
  connectors here only allow `[a-z0-9][a-z0-9-]*`.
- **Article content is HTML and gets rendered unescaped.** That is intended: it
  comes from your own Visibly account. Anyone accepting content from foreign
  accounts must sanitize.
- **The API key belongs in the environment**, never in the repository.

## Minimal implementation

Everything a connector must do, in pseudocode:

```
POST /webhook:
    if not verify_signature(raw_body, secret, header):   return 401
    payload = parse_json(raw_body)                       or return 400
    if payload.event not in KNOWN:                       return 200 {ignored}
    if already_processing(payload.article_id):           return 202 {already_processing}

    schedule_background(payload.article_id)
    return 202 {accepted}                                <- before any work

background(article_id):
    article = GET /api/v1/articles/{article_id}          or log and stop
    url = write_into_cms(article)                        or log and stop
    POST /api/v1/articles/{article_id}/confirm {url}
```
