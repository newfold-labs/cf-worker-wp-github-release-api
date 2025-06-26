/**
 * Handle the incoming request.
 *
 * @param event {Event}
 *
 * @returns {Promise<Response>}
 */
async function handleRequest(event) {
  const request = event.request
  const url = new URL(request.url)

  // Construct the cache key from the cache URL, omitting headers, which are variable (referrer includes the site URL)
  const cacheKey = new Request(url.toString())

  // Use a private cache namespace
  const cache = await caches.open('wp-github-release-api')

  // Check if response is in cache
  let response = await cache.match(cacheKey)

  // If cached, return stored result
  if (response) {
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

  // Get the release
  try {
    data.latestRelease = await getLatestRelease(data)
    data.release = data.version ? await getRelease(data) : data.latestRelease
  } catch (e) {
    try {
      if (data.isDownload) {
        const r2Response = await fetchFromR2(data)
        if (r2Response) {
          return r2Response // If found in R2, return the R2 response
        }
      }
    } catch (e) {
      return getErrorResponse(e.message, 404)
    }
    return getErrorResponse(e.message, 404)
  }

  const filePath = `https://raw.githubusercontent.com/${data.vendor}/${data.package}/${data.release.tag_name}/${data.file}`
  response = await gitHubRequest(filePath)

  // Unable to read base file
  if (response.status !== 200) {
    return getResponse(`Unable to fetch ${data.type} file: ${filePath}`, 404)
  }

  // Get file headers
  data.fileHeaders = getFileHeaders(await response.text())

  // Get payload
  const payload = getPayload(data)

  // Force a download
  if (data.isDownload) {
    // Save the file to R2 for future fallback
    try {
      await saveToR2(payload.download)
    } catch (error) {
      console.error('Error saving to R2:', error)
    }
    return Response.redirect(payload.download, 302)
  }

  // Prepare response
  response = getResponse(payload)

  // Set cache header
  response.headers.append('Cache-Control', 's-maxage=3600')

  // Cache response
  event.waitUntil(cache.put(cacheKey, response.clone()))

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

async function fetchFromR2(data) {
  const r2Bucket = RELEASE_API_R2_BUCKET
  let r2Key = `${data.package}.zip`
  let object

  try {
    if (data.version) {
      r2Key = `${data.version}-${data.package}.zip`
      object = await r2Bucket.get(r2Key)
    } else {
      // List, Filter and Sort the files in descending order by name
      const listObjects = await r2Bucket.list()
      const zipFiles = listObjects.objects.filter((file) =>
        file.key.endsWith(`-${data.package}.zip`),
      )
      zipFiles.sort((a, b) => {
        return b.key.localeCompare(a.key)
      })

      if (zipFiles.length > 0) {
        const latestFile = zipFiles[0]
        object = await r2Bucket.get(latestFile.key)

        // Delete older versions (all but the latest 5)
        for (let i = 5; i < zipFiles.length; i++) {
          await r2Bucket.delete(zipFiles[i].key)
        }
      }
    }

    if (object) {
      const r2Response = new Response(object.body, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${data.package}.zip"`,
        },
      })
      return r2Response
    }
  } catch (error) {
    throw new Error('Error fetching from R2')
  }

  return null
}

async function saveToR2(downloadUrl) {
  const parsedUrl = new URL(downloadUrl)
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean)
  const version = pathSegments[pathSegments.length - 2]

  const r2Bucket = RELEASE_API_R2_BUCKET
  const r2Key = `${version}-${pathSegments[pathSegments.length - 1]}`

  try {
    // Check if the file already exists in the R2 bucket
    const existingObject = await r2Bucket.get(r2Key)
    if (existingObject) {
      return
    }
    // Fetch the zip file
    const dresponse = await fetch(downloadUrl)
    if (dresponse.status !== 200) {
      return
    }
    const zipBlob = await dresponse.blob()

    await r2Bucket.put(r2Key, zipBlob, {
      httpMetadata: { contentType: 'application/zip' },
    })
  } catch (error) {
    console.error('Error saving to R2:', error)
  }
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
async function getLatestRelease(data) {
  let release, releases, response

  // Fetch the most recent releases from GitHub
  response = await gitHubRequest(
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
 * @param data {{}}
 *
 * @returns {Promise<*>}
 */
async function getRelease(data) {
  let release, releases, response

  // Fetch a specific release from GitHub
  response = await gitHubRequest(
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
 * @param url {string}
 *
 * @returns {Promise<Response>}
 */
async function gitHubRequest(url) {
  return await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: 'Basic ' + btoa(`${GITHUB_USER}:${GITHUB_TOKEN}`),
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

addEventListener('fetch', (event) => {
  event.respondWith(
    handleRequest(event).catch(
      (err) => new Response(err.stack, { status: 500 }),
    ),
  )
})
