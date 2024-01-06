const sha1 = async (message: string) => {
  // Encode as UTF-8.
  const msgBuffer = await new TextEncoder().encode(message)
  // Hash with md5 for speed and we don't need security here. The payloads are
  // pretty small so collisions are unlikely.
  const hashBuffer = await crypto.subtle.digest('MD5', msgBuffer)
  // Convert bytes to hex string.
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const ALLOWED_ORIGINS = [
  /localhost:.+/,
  /(.+\.)?daodao\.zone/,
  /.+\-da0da0\.vercel\.app/,
]

// Cache for 1 second.
const CACHE_SECONDS = 1

const cacheKeyForRequestAndBody = async (
  request: Request,
  body: string
): Promise<Request> => {
  // If body is a JSON object, set `id` to -1 so cache ignores unique ID.
  if (body && body.startsWith('{')) {
    const jsonBody = JSON.parse(body)
    if ('id' in jsonBody) {
      jsonBody.id = -1
      body = JSON.stringify(jsonBody)
    }
  }

  // Hash the request body to use it as a part of the cache key.
  const hash = body ? await sha1(body) : ''

  const cacheUrl = new URL(request.url)
  // Add hash of body to the path to get the cache key URL.
  cacheUrl.pathname = cacheUrl.pathname + hash
  const cacheKey = new Request(cacheUrl.toString(), {
    headers: request.headers,
    method: 'GET',
  })

  return cacheKey
}

//! Entrypoint.
export default {
  async fetch(
    request: Request,
    _: unknown,
    ctx: ExecutionContext
  ): Promise<Response> {
    const origin = request.headers.get('Origin') || ''

    try {
      const method = request.method.toUpperCase()
      if (method === 'GET' || method === 'POST') {
        let bodies: string[]
        if (request.headers.get('content-type') === 'application/json') {
          const jsonBody = (await request.clone().json()) as unknown

          // If many requests in one, stringify each individually.
          if (Array.isArray(jsonBody)) {
            bodies = jsonBody.map((b) => JSON.stringify(b))
          } else {
            bodies = [JSON.stringify(jsonBody)]
          }
        } else {
          bodies = [await request.clone().text()]
        }

        const cache = caches.default

        // First attempt to load cached responses.
        const bodiesWithResponses = await Promise.all(
          bodies.map(async (body, index) => {
            const cacheKey = await cacheKeyForRequestAndBody(request, body)

            // Find response in cache.
            const response = await cache.match(cacheKey)
            const responseBody = await response?.text()

            return {
              body,
              index,
              response: responseBody,
              cached: !!responseBody,
            }
          })
        )

        // Then fetch any uncached bodies in a batched request.
        const uncachedBodies = bodiesWithResponses.filter((b) => !b.cached)
        if (uncachedBodies.length > 0) {
          let uncachedResponse: Response
          let uncachedResponses: unknown[]
          if (uncachedBodies.length > 1) {
            uncachedResponse = await fetch(request, {
              headers: request.headers,
              body: JSON.stringify(
                uncachedBodies.map(({ body }) => JSON.parse(body))
              ),
            })
            uncachedResponses = await uncachedResponse.json()
            if (!Array.isArray(uncachedResponses)) {
              throw new Error(
                'Batched responses should be an array of responses.'
              )
            }

            if (uncachedBodies.length !== uncachedResponses.length) {
              throw new Error(
                'Batched responses do not matched uncached requests.'
              )
            }
          } else {
            uncachedResponse = await fetch(request, {
              headers: request.headers,
              body: uncachedBodies[0].body || undefined,
            })

            // If fetched HTML (probably home page), just return uncached.
            if (uncachedResponse.headers.get('content-type') === 'text/html') {
              return uncachedResponse
            }

            uncachedResponses = [await uncachedResponse.json()]
          }

          // Cache uncached bodies and update bodies with responses.
          await Promise.all(
            uncachedBodies.map(async ({ body, index }, queryIndex) => {
              const responseBody = JSON.stringify(uncachedResponses[queryIndex])

              const cacheKey = await cacheKeyForRequestAndBody(request, body)

              // Cache.
              const response = new Response(responseBody, uncachedResponse)
              response.headers.append(
                'Cache-Control',
                `s-maxage=${CACHE_SECONDS}`
              )

              // Store in cache.
              ctx.waitUntil(cache.put(cacheKey, response.clone()))

              // Update response.
              bodiesWithResponses[index].response = responseBody
            })
          )
        }

        if (bodiesWithResponses.length === 1) {
          return new Response(bodiesWithResponses[0].response, {
            headers: {
              'Content-Type': 'application/json',
              Cached: JSON.stringify(bodiesWithResponses[0].cached),
              // CORS.
              ...(ALLOWED_ORIGINS.some((r) => r.test(origin)) && {
                'Access-Control-Allow-Origin': origin,
              }),
            },
          })
        } else {
          return new Response(
            JSON.stringify(
              bodiesWithResponses.map(
                ({ response }) => response && JSON.parse(response)
              )
            ),
            {
              // Use headers from any of the responses. They should be the same.
              headers: {
                'Content-Type': 'application/json',
                Cached: JSON.stringify(
                  bodiesWithResponses
                    .filter(({ cached }) => cached)
                    .map(({ index }) => index)
                ),
                // CORS.
                ...(ALLOWED_ORIGINS.some((r) => r.test(origin)) && {
                  'Access-Control-Allow-Origin': origin,
                }),
              },
            }
          )
        }
      } else if (method === 'OPTIONS') {
        const corsRequestHeaders = request.headers.get(
          'Access-Control-Request-Headers'
        )

        if (
          origin &&
          request.headers.get('Access-Control-Request-Method') !== null &&
          corsRequestHeaders &&
          // Origin allowed.
          ALLOWED_ORIGINS.some((r) => r.test(origin))
        ) {
          // Handle CORS preflight requests.
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
              'Access-Control-Max-Age': '86400',
              'Access-Control-Allow-Headers': corsRequestHeaders,
            },
          })
        } else {
          // Handle standard OPTIONS request.
          return new Response(null, {
            headers: {
              Allow: 'GET, HEAD, POST, OPTIONS',
            },
          })
        }
      }

      return fetch(request)
    } catch (e) {
      console.error(e)
      return new Response(
        'Error thrown ' + (e instanceof Error ? e.message : e)
      )
    }
  },
}
