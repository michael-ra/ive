"""Read-only, bounded navigation of one explicitly selected handoff snapshot."""
import argparse
import codecs
import json
from pathlib import Path

from context_retrieval import encode, MAX_OUTPUT_CHARS

FILES = ("transcript.jsonl", "messages.jsonl", "context.json", "INDEX.md", "HANDOFF.md")
MAX_READ_BYTES = 3000
MAX_SCAN_BYTES = 16 * 1024 * 1024


def source_path(root, name):
    if name not in FILES:
        raise ValueError("Choose a handoff source file, not a directory or arbitrary path")
    root = Path(root).resolve(strict=True)
    path = root / name
    if path.is_symlink() or path.resolve(strict=True).parent != root or not path.is_file():
        raise ValueError("Source must be a regular file inside this snapshot")
    return path


def excerpt(path, offset, limit):
    if offset < 0 or offset > path.stat().st_size or limit < 1:
        raise ValueError("Invalid byte offset or length")
    with path.open("rb") as source:
        source.seek(offset)
        body = source.read(max(4, min(limit, MAX_READ_BYTES)))
    # Offsets refer to UTF-8 bytes. Align a cursor inside a multibyte character
    # and retain a partial final character for the next page.
    while body and body[0] & 0xC0 == 0x80:
        body = body[1:]; offset += 1
    decoder = codecs.getincrementaldecoder("utf-8")()
    text = decoder.decode(body, final=False)
    return text, offset


def read(root, name, offset=0, limit=2000):
    path = source_path(root, name)
    text, offset = excerpt(path, offset, limit)
    total = path.stat().st_size
    while True:
        end = offset + len(text.encode("utf-8"))
        result = {"file": name, "offset": offset, "text": text, "next_offset": end if end < total else None,
                  "total_bytes": total, "truncated": end < total}
        if len(encode(result)) <= MAX_OUTPUT_CHARS:
            return result
        text = text[:len(text) // 2]


def search(root, name, query, after=0):
    path = source_path(root, name)
    needle = query.encode("utf-8")
    if not 1 <= len(needle) <= 512 or after < 0 or after > path.stat().st_size:
        raise ValueError("Use a literal query of 1–512 UTF-8 bytes and a valid offset")
    total = path.stat().st_size
    stop = min(total, after + MAX_SCAN_BYTES)
    results = []
    cursor, carry = after, b""
    with path.open("rb") as source:
        source.seek(after)
        while cursor < stop:
            chunk = source.read(min(65536, stop - cursor))
            if not chunk:
                break
            data = carry + chunk
            base = cursor - len(carry)
            position = data.find(needle)
            while position >= 0:
                match = base + position
                text, start = excerpt(path, max(0, match - 100), max(480, len(needle) + 100))
                hit = {"file": name, "match_offset": match, "offset": start, "text": text}
                while len(encode(hit)) > 1000:
                    hit["text"] = hit["text"][:len(hit["text"]) // 2]
                results.append(hit)
                if len(results) == 5:
                    return {"matches": results, "next_offset": match + len(needle), "total_bytes": total}
                position = data.find(needle, position + len(needle))
            cursor += len(chunk)
            carry = data[-(len(needle) - 1):] if len(needle) > 1 else b""
    # Keep an overlap when a bounded scan ends in the middle of a match.
    return {"matches": results, "next_offset": max(after + 1, cursor - len(carry)) if cursor < total else None,
            "total_bytes": total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    find = sub.add_parser("search"); find.add_argument("query"); find.add_argument("--after", type=int, default=0)
    fetch = sub.add_parser("read"); fetch.add_argument("--offset", type=int, default=0); fetch.add_argument("--limit", type=int, default=2000)
    for command in (find, fetch):
        command.add_argument("--file", choices=FILES, default="transcript.jsonl")
    args = parser.parse_args()
    try:
        result = (search(args.root, args.file, args.query, args.after) if args.action == "search"
                  else read(args.root, args.file, args.offset, args.limit))
        print(encode(result))
    except (OSError, ValueError) as error:
        print(encode({"error": str(error)[:500]}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
