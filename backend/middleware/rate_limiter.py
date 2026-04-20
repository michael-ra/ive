import time
from collections import defaultdict
from aiohttp import web
from config import DEFAULT_RATE_LIMIT, RATE_LIMITS

# Store request timestamps for each client IP and endpoint
# Structure: { "ip_address": { "endpoint_path": [timestamp1, timestamp2, ...], ... }, ... }
client_request_history = defaultdict(lambda: defaultdict(list))

@web.middleware
async def rate_limit_middleware(request, handler):
    # Get client IP address
    peername = request.transport.get_extra_info('peername')
    if peername is not None:
        ip_address, _ = peername
    else:
        # Fallback for when peername is not available (e.g., tests, specific deployments)
        ip_address = request.headers.get('X-Forwarded-For', '127.0.0.1')

    path = request.path

    # Determine rate limit for the current path
    limit, window = DEFAULT_RATE_LIMIT  # Global default
    for endpoint_pattern, (ep_limit, ep_window) in RATE_LIMITS.items():
        if path.startswith(endpoint_pattern):
            limit, window = ep_limit, ep_window
            break

    current_time = time.time()
    # Clean up old requests outside the sliding window
    # Only keep requests that happened within the current window
    client_request_history[ip_address][path] = [
        t for t in client_request_history[ip_address][path] if t > current_time - window
    ]

    if len(client_request_history[ip_address][path]) >= limit:
        # Rate limit exceeded
        # Calculate when the client can retry
        retry_after = int(window - (current_time - client_request_history[ip_address][path][0])) + 1
        raise web.HTTPTooManyRequests(
            headers={
                "Retry-After": str(retry_after),
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(int(current_time + retry_after)),
            }
        )
    
    # Record the current request
    client_request_history[ip_address][path].append(current_time)

    # Allow the request to proceed
    response = await handler(request)

    # Add rate limit headers to the response for allowed requests
    remaining = limit - len(client_request_history[ip_address][path])
    response.headers["X-RateLimit-Limit"] = str(limit)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    # The reset time is the timestamp of the oldest request + window duration
    if client_request_history[ip_address][path]:
        reset_time = int(client_request_history[ip_address][path][0] + window)
    else:
        reset_time = int(current_time + window) # No requests yet, reset in 'window' seconds
    response.headers["X-RateLimit-Reset"] = str(reset_time)

    return response
