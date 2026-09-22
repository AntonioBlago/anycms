# AI Automation Connector for WordPress

## Install / update to 1.1.0

Replace `wp-content/plugins/ai-automation-connector/ai-automation-connector.php`
with this directory's `ai-automation-connector.php`. This is the only runtime
file; do not upload the test scripts. Existing settings and article mappings
are preserved. Activate the plugin if this is a new installation.

Requirement: a Visibly account on the Standard plan or higher. The plugin
imports articles the Content Autopilot writes, and the Autopilot (CMS
connection, project API key) is not part of the Free plan.

Under **Settings > AI Automation**, configure the shared webhook secret and
the Visibly API key, then copy the displayed webhook URL into Visibly. Use an
HTTPS webhook URL and preferably a project-specific `cp_…` API key. An `lc_…`
account key can access articles from multiple projects.

### Changes in 1.1.0

- Existing posts are updated only through `_aiac_article_id`. A matching slug
  never grants ownership of an unrelated post. Posts without this mapping are
  imported as new posts; published slug collisions are handled by WordPress.
- Every actionable webhook requires an HMAC-covered ISO 8601 `timestamp` with
  timezone. Requests older than five minutes or more than one minute in the
  future are rejected. The Visibly sender already supplies this field; keep
  the WordPress server clock synchronized.
- Repeated signed requests are acknowledged without importing again. Receipt
  reservations use atomic database inserts and are cleaned up after eleven
  minutes, beyond the timestamp acceptance window.
- Each distinct update is queued, including updates arriving during an import.
  Workers serialize imports per article. Cron writes from this plugin are
  serialized across PHP processes; failed scheduling returns `503` rather than
  claiming success. Network and worker-contention failures retry up to five
  times, after 30, 60, 120, 240 and 480 seconds.
- Draft and pending posts are not reported as published. Later manual
  publication queues a confirmation, and confirmations recheck the post status
  before sending. Confirmation failures retry without reimporting the article.
- `article.published` notifications are acknowledged without importing. Articles
  that are no longer `approved` or `published` in Visibly are not imported.
- Equal or older revisions preserve local edits. Trashed mapped posts are not
  recreated or restored by incoming webhooks.
- API calls require HTTPS, validate destinations through WordPress's safe HTTP
  API, verify TLS certificates and do not follow redirects with the API key.
- Imported HTML is explicitly filtered with `wp_kses_post`, even when executed
  as an administrator. Backslashes survive WordPress's write APIs.

The default post status remains **Draft**. Newer revisions of an already
published mapped post still update it publicly. Previously overwritten content
and publication states incorrectly reported by older plugin versions are not
automatically restored; review those against WordPress revisions and Visibly.

### Runtime requirements

WordPress 6.0+, PHP 8.0+, and a standard WordPress MySQL/MariaDB connection that
supports `GET_LOCK` / `RELEASE_LOCK`. A public HTTPS Visibly host is required;
HTTP hosts, URL credentials, query strings and fragments are rejected.

WP-Cron must be operational, using site traffic or a system cron invoking
`wp-cron.php`. An accepted webhook means the job was scheduled, not that the
article is already live. Failed retries and queue errors are written to the
PHP error log with an `[aiac]` prefix. As with other WP-Cron jobs, execution time
depends on the site's cron setup.

## Tests

Pure signature checks, without WordPress:

```sh
php test_signature.php
```

Integration tests use real WordPress REST requests, posts, HTML filtering,
database reservations and cron scheduling. Outgoing HTTP is intercepted; no
real Visibly API key is needed. They also launch eight concurrent PHP processes.

**Use a disposable WordPress installation. The suite deletes its posts and
connector settings.** Add `define('AIAC_TESTING', true);` to that installation's
`wp-config.php`, then run:

```sh
wp eval-file /path/to/apps/wordpress/test_wordpress.php
```

`test_worker.php` is the child process used by the concurrency test. The CLI
PHP configuration must allow `proc_open`.

Validated with WordPress 7.1, PHP 8.3.33 and MySQL 8.0: 8 signature checks and
31 integration tests pass. This does not test the configuration of a live site.
