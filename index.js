import { getKV, setKV } from './src/kv'

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  },
}

/**
 * Handle the incoming request.
 *
 *
 * @returns {Promise<Response>}
 */
// async function handleRequest(event) {
async function handleRequest(request, env, ctx) {
  // const request = event.request
  const url = new URL(request.url)

  // Construct the cache key from the cache URL, omitting headers, which are variable (referrer includes the site URL)
  const cacheKey = url

  // Use a private cache namespace
  const cache = await caches.open('wp-github-release-api')

  // Check if response is in cache
  // let response = await cache.match(cacheKey)
  // let response = await ctx.waitUntil(cache.match(cacheKey))
  let response = await cache.match(cacheKey)

  if(response) {
    console.log(`Cache hit for URL: ${cacheKey}`)
  } else {
    console.log(`Cache miss for URL: ${cacheKey}`)
  }

  // If cached, return stored result
  if (response) {
    console.log(`Returning cached response.`)
    return response
  }

  // Get the data from the request
  const data = getDataFromRequest(request)

  // Run some error checks
  if (data.type !== 'theme' && data.type !== 'plugin') {
    return getErrorResponse(
      "The first URL path segment is missing a valid entity type. Must be either 'plugins' or 'themes'.",
    )
  }

  if (!data.vendor) {
    return getErrorResponse(
      'The second URL path segment is missing. It should contain the vendor name.',
    )
  }

  if (!data.package) {
    return getErrorResponse(
      'The third URL path segment is missing. It should contain the package name.',
    )
  }

  const cachedData = await getKV(env, url.pathname)
  if (cachedData && data.isDownload && cachedData.latestRelease && cachedData.latestRelease.tag_name) {
    console.log(`Found KV cached data for ${url.pathname}`)
    const version = cachedData.latestRelease.tag_name
    const r2Response = await fetchSavedFromR2(env, data, version)
    if (r2Response) {
      console.log(`Caching R2 response object with key: ${cacheKey}`)
      await cache.put(cacheKey, r2Response.clone());

      console.log('Returning R2 response')
      return r2Response // If found in R2, return the R2 response
    }
  } else {
    console.log(`No KV cached data for ${url.pathname}`)
  }

  // Get the release
  try {
    data.latestRelease = await getLatestReleaseDetailJsonFromGitHub(env, data)
    data.release = data.version ? await getRelease(env, data) : data.latestRelease
  } catch (e) {
    return getErrorResponse(e.message, 404)
  }

  const filePath = `https://raw.githubusercontent.com/${data.vendor}/${data.package}/${data.release.tag_name}/${data.file}`
  response = await gitHubRequest(env, filePath)

  // Unable to read base file
  if (response.status !== 200) {
    return getResponse(`Unable to fetch ${data.type} file: ${filePath}`, 404)
  }

  // Get file headers
  data.fileHeaders = getFileHeaders(await response.text())

  // Get payload
  const payload = getPayload(data)

  console.log(`KV Caching data object for ${url.pathname}`)
  await setKV(env, url.pathname, data)

  // const testKv = await getKV(env, url.pathname)
  // console.log(`KV Cached data object: ${JSON.stringify(testKv)}`)

  // Force a download
  if (data.isDownload) {
    // Save the file to R2 for future fallback
    try {
      const version = data.latestRelease.tag_name
      await saveToR2(env, data, version, payload.download)
      const r2Response = await fetchSavedFromR2(
        env,
        data,
        data.latestRelease.tag_name,
      )
      if (r2Response) {
        console.log('Found in R2')
        console.log(`Caching R2 response object with key: ${cacheKey}`)
        await cache.put(cacheKey, r2Response.clone());
        console.log('Returning response')
        return r2Response // If found in R2, return the R2 response
      }
    } catch (error) {
      console.error('Error saving to R2:', error)
    }
    return Response.redirect(payload.download, 302)
  }

  // Prepare response
  response = getResponse(payload)

  // Set cache header
  // "shared max-age"
  response.headers.append('Cache-Control', 's-maxage=3600')

  // Cache response
  await cache.put(cacheKey, response.clone())

  // Return response to the user
  return response
}

/**
 * Get data from the request.
 *
 * @param request
 * @returns {{}}
 */
function getDataFromRequest(request) {
  const url = new URL(request.url)

  const cleanPath = url.pathname
    .replace(/^\/?workers/, '') // Remove /workers
    .replace(/^\/?release-api(-staging)?/, '') // Remove /release-api and /release-api-staging
    .replace(/^\/+/g, '') // Trim leading slashes

  const segments = cleanPath.split('/').filter((value) => !!value)

  // Set entity type
  let type = segments.shift()

  if (type && (type === 'plugin' || type === 'plugins')) {
    type = 'plugin'
  }

  if (type && (type === 'theme' || type === 'themes')) {
    type = 'theme'
  }

  // Set vendor name
  const vendor = segments.shift()

  // Set package name
  const _package = segments.shift()

  // Check if we should download
  let isDownload = segments.includes('download')
  if (isDownload) {
    segments.pop() // Remove segment so we don't accidentally grab it in the next step
  }

  // Set version, if provided
  let version = segments.shift()

  // Set slug
  const slug = url.searchParams.get('slug') || _package

  // Set file
  const file =
    url.searchParams.get('file') ||
    (type === 'theme' ? 'style.css' : `${_package}.php`)

  // Set basename
  const basename = `${slug}/${file}`

  return {
    basename,
    file,
    isDownload,
    package: _package, // Package is a reserved keyword in JavaScript
    slug,
    type,
    vendor,
    version,
  }
}

async function fetchSavedFromR2(env, data, version) {
  // const r2Bucket = getR2Bucket()
  let r2Key = `${data.package}.zip`
  let object

  try {
    r2Key = getFullR2Key(data, version)
    object = await env.RELEASE_API_R2_BUCKET.get(r2Key)

    if (object) {

      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${data.slug}.zip"`,
        },
      })
    }
  } catch (error) {
    throw new Error(`Error fetching from R2 ${error.message}`)
  }

  return null
}

async function saveToR2(env, data, version, downloadUrl) {
  const r2Key = getFullR2Key(data, version)

  console.log(`Saving to R2: ${r2Key}, downloadUrl: ${downloadUrl}`)

  try {
    // Check if the file already exists in the R2 bucket
    if (await fetchSavedFromR2(env, data, version)) {
      console.log(`File already exists in R2; no need to save: ${r2Key}`)
      return
    }
    // Fetch the zip file
    const downloadResponse = await fetch(downloadUrl)
    if (downloadResponse.status !== 200) {
      return
    }
    const responseClone = downloadResponse.clone()
    const zipBlob = await responseClone.blob()

    await env.RELEASE_API_R2_BUCKET.put(r2Key, zipBlob, {
      httpMetadata: { contentType: 'application/zip' },
    })
  } catch (error) {
    console.error('Error saving to R2:', error)
  }
}

function getFullR2Key(data, version) {
  return `${version}-${data.package}.zip`
}

/**
 * Get response payload.
 *
 * @param data {{}}
 * @returns {{}}
 */
function getPayload(data) {
  const payload = {
    name:
      data.type === 'theme'
        ? data.fileHeaders['Theme Name']
        : data.fileHeaders['Plugin Name'],
    type: data.type,
    version: {
      current: data.fileHeaders['Version'],
      latest: data.latestRelease.tag_name,
    },
    description: data.fileHeaders['Description'] || '',
    author: {
      name: data.fileHeaders['Author'] || '',
      url: data.fileHeaders['Author URI'] || '',
    },
    updated: data.release.published_at || '',
    requires: {
      wp: data.fileHeaders['Requires at least'] || '',
      php: data.fileHeaders['Requires PHP'] || '',
    },
    tested: {
      wp: data.fileHeaders['Tested up to'] || '',
    },
    url:
      (data.type === 'theme'
        ? data.fileHeaders['Theme URI']
        : data.fileHeaders['Plugin URI']) || '',
    download: data.release.assets[0].browser_download_url,
    slug: data.slug,
  }

  if (data.type === 'plugin') {
    payload.basename = data.basename
  }

  return payload
}

/**
 * Get the latest viable release.
 *
 * @param data {{}}
 *
 * @returns {Promise<*>}
 */
async function getLatestReleaseDetailJsonFromGitHub(env, data) {
  let release, releases, response

  // Fetch the most recent releases from GitHub
  response = await gitHubRequest(
    env,
    `https://api.github.com/repos/${data.vendor}/${data.package}/releases`,
  )
  releases = await response.json()

  // Proxy error response
  if (response.status !== 200) {
    throw new Error(JSON.stringify(releases))
  }

  if (!releases || !Array.isArray(releases) || !releases.length) {
    throw new Error('No releases available!')
  }

  // Sort by date published
  releases.sort(function (a, b) {
    return a.published_at > b.published_at
      ? -1
      : a.published_at < b.published_at
      ? 1
      : 0
  })

  const validReleases = []

  for (release of releases) {
    // Skip over draft releases
    if (release.draft) {
      continue
    }
    // Skip over pre-releases
    if (release.prerelease) {
      continue
    }
    // Skip over releases without release assets.
    if (!release.assets.length) {
      continue
    }
    validReleases.push(release)
  }

  if (validReleases.length <= 0) {
    throw new Error('No valid releases available!')
  }

  return validReleases[0]
}

/**
 * Get a specific plugin or theme release.
 *
 * @param env
 * @param data {{}}
 *
 * @returns {Promise<*>}
 */
async function getRelease(env, data) {
  let release, response

  // Fetch a specific release from GitHub
  response = await gitHubRequest(
    env,
    `https://api.github.com/repos/${data.vendor}/${data.package}/releases/tags/${data.version}`,
  )
  release = await response.json()

  // Proxy error response
  if (response.status !== 200) {
    throw new Error(JSON.stringify(release))
  }

  // Release doesn't have a downloadable
  if (!release.assets.length) {
    throw new Error(`Release ${data.version} doesn't have a release asset!`)
  }

  return release
}

/**
 * Get status text code given an HTTP status code.
 *
 * @param code {integer}
 * @returns {string}
 */
function getStatusText(code) {
  switch (code) {
    case 400:
      return 'Bad Request'
    case 404:
      return 'Not Found'
    default:
      return 'OK'
  }
}

/**
 * Get a new Response object.
 *
 * @param payload {{}}
 * @param status {integer}
 *
 * @returns {Response}
 */
function getResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    statusText: getStatusText(status),
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

/**
 * Get a new Response object and set up error payload.
 *
 * @param message {string}
 * @param statusCode {integer}
 *
 * @returns {Response}
 */
function getErrorResponse(message, statusCode = 400) {
  return getResponse({ status: 'error', message }, statusCode)
}

/**
 * Make a request to GitHub.
 *
 * @param env
 * @param url {string}
 *
 * @returns {Promise<Response>}
 */
async function gitHubRequest(env, url) {
  return await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: 'Basic ' + btoa(`${env.GITHUB_USER}:${env.GITHUB_TOKEN}`),
      'User-Agent': 'Cloudflare Workers',
    },
  })
}

/**
 * Get plugin or theme file headers.
 *
 * @param fileContents {string}
 * @returns {{}}
 */
function getFileHeaders(fileContents) {
  const headers = [
    'Author',
    'Author URI',
    'Description',
    'Domain Path',
    'License',
    'License URI',
    'Plugin Name',
    'Plugin URI',
    'Requires at least',
    'Requires PHP',
    'Tested up to',
    'Text Domain',
    'Theme Name',
    'Theme URI',
    'Version',
  ]

  const fileHeaders = {}

  headers.forEach((header) => {
    let regex = new RegExp(header + ':(.*)', 'gm')
    let matches = regex.exec(fileContents)
    if (matches && matches.hasOwnProperty(1)) {
      fileHeaders[header] = matches[1].trim()
    }
  })

  return fileHeaders
}
