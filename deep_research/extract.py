"""Web content extraction — URL to clean text.

Uses trafilatura (best open-source extractor) if installed,
falls back to regex-based HTML stripping.
"""

import asyncio
import logging
import re

import aiohttp

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

MAX_CONTENT_CHARS = 8000


async def _fetch_html(url: str, timeout: int = 20) -> str | None:
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                headers=_HEADERS,
                timeout=aiohttp.ClientTimeout(total=timeout),
                allow_redirects=True,
                max_redirects=5,
            ) as resp:
                if resp.status != 200:
                    return None
                ct = resp.headers.get("Content-Type", "")
                if "text/html" not in ct and "application/xhtml" not in ct:
                    return None
                return await resp.text(errors="replace")
    except Exception as e:
        logger.debug("Fetch failed %s: %s", url, e)
        return None


def _trafilatura_extract(html: str) -> str | None:
    try:
        import trafilatura
        text = trafilatura.extract(html, include_links=True, include_tables=True, favor_recall=True)
        if text and len(text) > 100:
            return text[:MAX_CONTENT_CHARS]
    except ImportError:
        pass
    except Exception as e:
        logger.debug("trafilatura failed: %s", e)
    return None


def _regex_extract(html: str) -> str | None:
    text = re.sub(r"<(script|style|nav|footer|header|aside)[^>]*>.*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for ent, ch in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")]:
        text = text.replace(ent, ch)
    return text[:MAX_CONTENT_CHARS] if len(text) > 200 else None


async def extract_content(url: str, timeout: int = 20) -> str | None:
    """Fetch URL → clean text. Trafilatura first, regex fallback."""
    html = await _fetch_html(url, timeout)
    if not html:
        return None
    return _trafilatura_extract(html) or _regex_extract(html)


async def extract_multiple(urls: list[str], max_concurrent: int = 8) -> dict[str, str]:
    """Extract content from multiple URLs concurrently. Returns {url: text}."""
    semaphore = asyncio.Semaphore(max_concurrent)
    results: dict[str, str] = {}

    async def _one(url: str):
        async with semaphore:
            content = await extract_content(url)
            if content:
                results[url] = content

    await asyncio.gather(*[_one(u) for u in urls], return_exceptions=True)
    logger.info("Extracted %d/%d URLs", len(results), len(urls))
    return results
