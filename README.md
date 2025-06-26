# WordPress GitHub Release API

A Cloudflare Worker that provides a REST API for WordPress plugin and theme data. Most commonly, this API is used to manage custom plugin and theme updates in WordPress.

All data is fetched from GitHub directly and makes a few assumptions:

- Your WordPress plugin or theme lives in a public or private GitHub repository.
- You've created at least one [release](https://docs.github.com/en/github/administering-a-repository/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release) on GitHub.
- Your releases contain a `.zip` artifact that is used for the plugin or theme installation and the file name matches the repo slug.

## Prerequisites

- Install [Node and NPM](https://nodejs.org/en/download/).

## Local Setup

- Run `git clone git@github.com:newfold-labs/cf-worker-wp-github-release-api.git` to clone the repository.
- Run `npm install`
- Run `cp wrangler.example.toml wrangler.toml` to create your own `wrangler.toml` file.
- Run `npx wrangler whoami` to get your Cloudflare Account ID. You may have to run `npx wrangler login` first.
- Set your Cloudflare Account ID as `account_id` in the `wrangler.toml` file.
- Set your Cloudflare Zone ID as `zone_id` in the `wrangler.toml` file (multiple locations).
- Create a `.dev.vars` file and set your GitHub username and token as `GITHUB_USER` and `GITHUB_TOKEN` in the file.
- Run `npm start` to start the local dev environment.

## Remote Setup

- Run `wrangler secret put GITHUB_USER` to set your GitHub user as an environmental secret on Cloudflare.
- Run `wrangler secret put GITHUB_TOKEN` to set your GitHub token as an environmental secret on Cloudflare.

## Deployments

### Production

Any push to the `master` branch on your GitHub repo will trigger the `.github/workflows/deploy-cloudflare-worker.yml`
workflow via GitHub Actions and deploy your Worker to Cloudflare automatically.

### Staging

Any push to the `staging` branch on your GitHub repo will trigger the `.github/workflows/deploy-cloudflare-staging-worker.yml`
workflow via GitHub Actions and deploy your Worker to Cloudflare automatically.

If you want to test code before pushing code to the `staging` branch, you can run `npm run deploy:staging`.

## Usage

You can access the production API at `https://hiive.cloud/workers/release-api` and the staging API at `https://hiive.cloud/workers/release-api-staging`

Requests to the API use the following pattern: `/:entity/:vendor:/:package/[:version]/[download]`.

**Plugin Requests**

```shell
# Get plugin info for latest version
/plugins/:vendor/:package

# Get plugin data for specific version
/plugins/:vendor/:package/:version

# Download latest plugin version
/plugins/:vendor/:package/download

# Download specific plugin version
/plugins/:vendor/:package/:version/download
```

**Theme Requests**

```shell
# Get theme info for latest version
/themes/:vendor/:package

# Get theme data for specific version
/themes/:vendor/:package/:version

# Download latest theme version
/themes/:vendor/:package/download

# Download specific theme version
/themes/:vendor/:package/:version/download
```

Required path parameters:

- **entity** - The entity type. Can be either `plugin`, `plugins`, `theme` or `themes`.
- **vendor** - This is the GitHub username or organization name where the repository is located.
- **package** - This is the slug of the GitHub repository name.

Optional path parameters:

- **version** - The plugin or theme version number. When absent, the latest version will be returned. When present,
  the requested version will be returned.
- **download** - When appended to the URL path, this will trigger a download of the plugin or theme `.zip` file.

Optional query parameters:

- **slug** - The folder name of the plugin or theme. Allows you to override your plugin or theme slug if it is
  different from the package name.
- **file** - The file containing the WordPress plugin headers. Only required for plugin requests, this allows you to
  override the main plugin file name if it doesn't match the expected pattern: `{package}.php`.

### Plugin Request Example

#### Request

```shell
/plugins/wpscholar-wp-plugins/shortcode-scrubber

# OR

/plugins/wpscholar-wp-plugins/shortcode-scrubber/1.0.3
```

In this scenario, the plugin basename is assumed to be `shortcode-scrubber/shortcode-scrubber.php`. This is derived
from the provided `slug` and `file` query parameters, if provided. Otherwise, the slug is assumed to match the
`package` name and the `file` is assumed to match the `{package}.php` pattern.

```text
/plugins/wpscholar-wp-plugins/shortcode-scrubber?slug=shortcode-scrubber-pro&file=scrubber.php
```

The example above would result in the following plugin basename: `shortcode-scrubber-pro/scrubber.php`.

#### Response

```json
{
  "name": "Shortcode Scrubber",
  "type": "plugin",
  "version": {
    "current": "1.0.3",
    "latest": "1.0.3"
  },
  "description": "A powerful tool for cleaning up shortcodes on your site and confidently managing plugins and themes that use shortcodes.",
  "author": {
    "name": "Micah Wood",
    "url": "https://wpscholar.com"
  },
  "updated": "2020-05-11T22:23:45Z",
  "slug": "shortcode-scrubber",
  "basename": "shortcode-scrubber/shortcode-scrubber.php",
  "url": "https://wpscholar.com/wordpress-plugins/shortcode-scrubber/",
  "download": "https://github.com/wpscholar-wp-plugins/shortcode-scrubber/releases/download/1.0.3/shortcode-scrubber.zip",
  "requires": {
    "wp": "3.2",
    "php": "5.6"
  },
  "tested": {
    "wp": ""
  }
}
```

### Theme Request Example

#### Request

```shell
/themes/wpscholar/block-theme

# OR

/themes/wpscholar/block-theme/1.0
```

#### Response

```json
{
  "name": "Block Theme",
  "type": "theme",
  "version": {
    "current": "1.0",
    "latest": "1.0"
  },
  "description": "A block theme experiment",
  "author": {
    "name": "Micah Wood",
    "url": "https://wpscholar.com"
  },
  "updated": "2021-08-06T13:27:23Z",
  "slug": "block-theme",
  "url": "",
  "download": "https://github.com/wpscholar/block-theme/releases/download/1.0/block-theme.zip",
  "requires": {
    "wp": "",
    "php": ""
  },
  "tested": {
    "wp": ""
  }
}
```
