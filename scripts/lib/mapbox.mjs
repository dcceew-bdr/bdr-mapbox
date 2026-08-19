// Thin wrapper around the Mapbox REST API using the built-in fetch (Node >= 18).

const BASE_URL = 'https://api.mapbox.com'

/**
 * Calls a Mapbox API endpoint and returns the parsed JSON body.
 * Throws an Error with a readable message on non-2xx responses.
 *
 * @param {string} path  e.g. "/tilesets/v1/sources/me/foo"
 * @param {object} opts
 * @param {string} opts.token  Mapbox access token (added as ?access_token=)
 * @param {string} [opts.method]
 * @param {BodyInit} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {Record<string,string>} [opts.query]
 */
export async function mapboxFetch(path, { token, method = 'GET', body, headers, query } = {}) {
  const url = new URL(path, BASE_URL)
  url.searchParams.set('access_token', token)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  }

  const res = await fetch(url, { method, body, headers })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }

  if (!res.ok) {
    const message = json?.message || json?.error || text || res.statusText
    const error = new Error(`Mapbox API ${method} ${url.pathname} → ${res.status}: ${message}`)
    error.status = res.status
    error.body = json
    throw error
  }
  return json
}

/** Small helper to redact tokens before printing a URL/string in logs. */
export function redact(str) {
  return String(str).replace(/(access_token=)(sk|pk|tk)\.[^&\s]+/g, '$1$2.****')
}
