/**
 * Get a value from KV.
 * @param env
 * @param {string} key - The key to retrieve
 * @returns {Promise<any>} - The parsed value or null
 */
export async function getKV(env, key) {
  const value = await env.RELEASE_API_KV_STORE.get(key, { type: 'json' })
  return value || null
}

/**
 * Set a value in KV with TTL (in seconds).
 * @param env
 * @param {string} key - The key to set
 * @param {any} value - The value to store
 * @param {number} ttl - Time to live in seconds
 * @returns {Promise<void>}
 */
export async function setKV(env, key, value, ttl = 60 * 60 * 4) {
  await env.RELEASE_API_KV_STORE.put(key, JSON.stringify(value), {
    expirationTtl: ttl,
  })
}
