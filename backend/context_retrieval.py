"""Bound model-visible retrieval, without modifying stored evidence or UI APIs."""
import json

MAX_OUTPUT_CHARS = 6000
MAX_PAGE_CHARS = 4000
MAX_RESULTS = 5


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def page(content, metadata, *, offset=0, limit=2000):
    if type(offset) is not int or offset < 0 or offset > len(content):
        return {"ok": False, "error": "offset must be within the source content"}
    if type(limit) is not int or limit < 1:
        return {"ok": False, "error": "limit must be a positive integer"}
    maximum = min(limit, MAX_PAGE_CHARS, len(content) - offset)

    def result(size):
        end = offset + size
        return {**metadata, "content": content[offset:end], "offset": offset,
                "next_offset": end if end < len(content) else None,
                "total_chars": len(content), "truncated": end < len(content)}

    low, high = 0, maximum
    while low < high:
        middle = (low + high + 1) // 2
        if len(encode(result(middle))) <= MAX_OUTPUT_CHARS:
            low = middle
        else:
            high = middle - 1
    return result(low)


def recall_result(hit, scope, args):
    metadata = {"ok": True, "scope": scope}
    for key, limit in (("id", 100), ("name", 160), ("type", 40), ("description", 240), ("updated_at", 40)):
        metadata[key] = str(hit.get(key) or "")[:limit]
    return encode(page(hit.get("content") or "", metadata,
                       offset=args.get("offset", 0), limit=args.get("limit", 2000)))


def search_result(result, query):
    if not isinstance(result, dict) or "error" in result:
        return encode({"error": str(result.get("error") if isinstance(result, dict) else "Search unavailable")[:500],
                       "status": result.get("status") if isinstance(result, dict) else None})
    buckets = result.get("results", {})
    visible = {kind: [] for kind in buckets}
    response = {"query": str(query)[:200], "results": visible, "total": result.get("total", 0),
                "truncated": False, "notes": [str(note)[:240] for note in result.get("notes", [])[:1]],
                "next_action": "Narrow query/types; recall_memory(id, offset, limit) loads a note. snippet_offset is a character offset in snippet_field."}
    terms = str(query).lower().split()[:12]
    count = 0
    # Give each selected record type a chance before taking another hit.
    for index in range(max((len(rows) for rows in buckets.values()), default=0)):
        for kind, rows in buckets.items():
            if index >= len(rows):
                continue
            if count >= MAX_RESULTS:
                response["truncated"] = True
                continue
            row = rows[index]
            hit = {key: str(row[key])[:size] for key, size in
                   (("id", 100), ("name", 160), ("title", 160), ("file_path", 300), ("status", 40))
                   if row.get(key) is not None}
            fields = [(key, value) for key, value in row.items() if isinstance(value, str) and key not in hit]
            found = next(((key, value, min(value.lower().find(term) for term in terms if term in value.lower()))
                          for key, value in fields if any(term in value.lower() for term in terms)), None)
            if found:
                key, value, position = found
            else:
                key, value = max(fields, key=lambda field: len(field[1]), default=("", ""))
                position = 0
            start = max(0, position - 100)
            hit.update(snippet_field=key, snippet=value[start:start + 400], snippet_offset=start,
                       source_chars=len(value))
            visible[kind].append(hit)
            if len(encode(response)) > MAX_OUTPUT_CHARS - 100:
                visible[kind].pop()
                response["truncated"] = True
            else:
                count += 1
    response["truncated"] |= count < response["total"]
    return encode(response)
