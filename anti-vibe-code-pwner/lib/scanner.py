#!/usr/bin/env python3
"""
AVCP Scanner — multi-ecosystem package security checker.

Zero external dependencies (stdlib only).
Checks: publish recency, OSV vulnerabilities, GitHub advisories.

Usage:
  python3 scanner.py check <ecosystem> <package> [--threshold 7]
  python3 scanner.py check-multi <ecosystem> <pkg1> <pkg2> ... [--threshold 7]
  python3 scanner.py osv <ecosystem> <package> [<version>]
  python3 scanner.py advisories <ecosystem> <package>

Output: JSON to stdout, diagnostics to stderr.
"""

import json
import sys
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone, timedelta
from typing import Optional

TIMEOUT = 15  # seconds per HTTP request


# ── Registry APIs ──

def fetch_json(url: str) -> Optional[dict]:
    """Fetch JSON from URL, return None on failure."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "avcp/0.3"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"[avcp] fetch failed: {url} — {e}", file=sys.stderr)
        return None


def post_json(url: str, data: dict) -> Optional[dict]:
    """POST JSON, return response dict or None."""
    try:
        body = json.dumps(data).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "User-Agent": "avcp/0.3"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"[avcp] POST failed: {url} — {e}", file=sys.stderr)
        return None


# ── Recency check per ecosystem ──

def check_pypi(pkg: str, threshold_days: int) -> dict:
    data = fetch_json(f"https://pypi.org/pypi/{pkg}/json")
    if not data:
        return {"status": "warn", "package": pkg, "ecosystem": "pypi", "reason": "could not fetch from PyPI"}

    latest = data["info"]["version"]
    releases = data["releases"].get(latest, [])
    if not releases:
        return {"status": "ok", "package": pkg, "ecosystem": "pypi", "version": latest, "age_days": -1}

    upload = datetime.fromisoformat(releases[0]["upload_time_iso_8601"].replace("Z", "+00:00"))
    age = datetime.now(timezone.utc) - upload
    age_days = age.days

    result = {
        "package": pkg, "ecosystem": "pypi", "version": latest,
        "age_days": age_days, "publish_date": upload.isoformat(),
    }

    if age_days < threshold_days:
        result["status"] = "flagged"
        result["fallback"] = _find_pypi_fallback(data, threshold_days)
    else:
        result["status"] = "ok"
    return result


def _find_pypi_fallback(data: dict, threshold_days: int) -> str:
    threshold = timedelta(days=threshold_days)
    now = datetime.now(timezone.utc)
    versions = []
    for ver, files in data["releases"].items():
        if not files:
            continue
        if any(c.isalpha() for c in ver.replace(".", "")):
            continue
        u = datetime.fromisoformat(files[0]["upload_time_iso_8601"].replace("Z", "+00:00"))
        if (now - u) >= threshold:
            versions.append((ver, u))
    versions.sort(key=lambda x: x[1], reverse=True)
    return versions[0][0] if versions else ""


def check_npm(pkg: str, threshold_days: int) -> dict:
    data = fetch_json(f"https://registry.npmjs.org/{urllib.parse.quote(pkg, safe='@')}")
    if not data:
        return {"status": "warn", "package": pkg, "ecosystem": "npm", "reason": "could not fetch from npm"}

    latest = data.get("dist-tags", {}).get("latest", "")
    if not latest:
        return {"status": "warn", "package": pkg, "ecosystem": "npm", "reason": "no latest tag"}

    pub_time = data.get("time", {}).get(latest, "")
    if not pub_time:
        return {"status": "ok", "package": pkg, "ecosystem": "npm", "version": latest, "age_days": -1}

    pub = datetime.fromisoformat(pub_time.replace("Z", "+00:00"))
    age = datetime.now(timezone.utc) - pub
    age_days = age.days

    result = {
        "package": pkg, "ecosystem": "npm", "version": latest,
        "age_days": age_days, "publish_date": pub.isoformat(),
    }

    if age_days < threshold_days:
        result["status"] = "flagged"
        result["fallback"] = _find_npm_fallback(data, threshold_days)
    else:
        result["status"] = "ok"
    return result


def _find_npm_fallback(data: dict, threshold_days: int) -> str:
    threshold = timedelta(days=threshold_days)
    now = datetime.now(timezone.utc)
    versions = []
    for ver, ts in data.get("time", {}).items():
        if ver in ("created", "modified"):
            continue
        if any(c.isalpha() for c in ver.replace(".", "")):
            continue
        u = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if (now - u) >= threshold:
            versions.append((ver, u))
    versions.sort(key=lambda x: x[1], reverse=True)
    return versions[0][0] if versions else ""


def check_crates(pkg: str, threshold_days: int) -> dict:
    data = fetch_json(f"https://crates.io/api/v1/crates/{pkg}")
    if not data or "crate" not in data:
        return {"status": "warn", "package": pkg, "ecosystem": "cargo", "reason": "could not fetch from crates.io"}

    crate = data["crate"]
    latest = crate.get("newest_version", "")
    updated = crate.get("updated_at", "")

    # Get version details for precise publish date
    versions = data.get("versions", [])
    publish_date = ""
    age_days = -1
    fallback = ""

    if versions:
        # Find the latest version's created_at
        for v in versions:
            if v.get("num") == latest:
                publish_date = v.get("created_at", "")
                break

        if publish_date:
            pub = datetime.fromisoformat(publish_date.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc) - pub).days

            if age_days < threshold_days:
                # Find fallback
                threshold = timedelta(days=threshold_days)
                now = datetime.now(timezone.utc)
                safe = []
                for v in versions:
                    if v.get("yanked"):
                        continue
                    vnum = v.get("num", "")
                    if any(c.isalpha() for c in vnum.replace(".", "")):
                        continue
                    created = v.get("created_at", "")
                    if created:
                        u = datetime.fromisoformat(created.replace("Z", "+00:00"))
                        if (now - u) >= threshold:
                            safe.append((vnum, u))
                safe.sort(key=lambda x: x[1], reverse=True)
                fallback = safe[0][0] if safe else ""

                return {
                    "status": "flagged", "package": pkg, "ecosystem": "cargo",
                    "version": latest, "age_days": age_days,
                    "publish_date": publish_date, "fallback": fallback,
                }

    return {
        "status": "ok", "package": pkg, "ecosystem": "cargo",
        "version": latest, "age_days": age_days,
        "publish_date": publish_date,
    }


def check_go(pkg: str, threshold_days: int) -> dict:
    # Go module proxy: proxy.golang.org
    # pkg format: github.com/user/repo
    encoded = pkg.replace("/", "/").lower()  # Go proxy uses case-encoded paths
    info = fetch_json(f"https://proxy.golang.org/{encoded}/@latest")
    if not info:
        return {"status": "warn", "package": pkg, "ecosystem": "go", "reason": "could not fetch from Go proxy"}

    version = info.get("Version", "")
    time_str = info.get("Time", "")

    if not time_str:
        return {"status": "ok", "package": pkg, "ecosystem": "go", "version": version, "age_days": -1}

    pub = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
    age_days = (datetime.now(timezone.utc) - pub).days

    result = {
        "package": pkg, "ecosystem": "go", "version": version,
        "age_days": age_days, "publish_date": time_str,
    }

    if age_days < threshold_days:
        result["status"] = "flagged"
        # Try to get version list for fallback
        try:
            req = urllib.request.Request(
                f"https://proxy.golang.org/{encoded}/@v/list",
                headers={"User-Agent": "avcp/0.3"},
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                version_list = resp.read().decode().strip().split("\n")
            # Check each version's timestamp (expensive, limit to last 10)
            threshold = timedelta(days=threshold_days)
            now = datetime.now(timezone.utc)
            safe = []
            for v in version_list[-10:]:
                v = v.strip()
                if not v or any(c.isalpha() for c in v.replace(".", "").lstrip("v")):
                    continue
                vinfo = fetch_json(f"https://proxy.golang.org/{encoded}/@v/{v}.info")
                if vinfo and vinfo.get("Time"):
                    vt = datetime.fromisoformat(vinfo["Time"].replace("Z", "+00:00"))
                    if (now - vt) >= threshold:
                        safe.append((v, vt))
            safe.sort(key=lambda x: x[1], reverse=True)
            result["fallback"] = safe[0][0] if safe else ""
        except Exception:
            result["fallback"] = ""
    else:
        result["status"] = "ok"

    return result


def check_rubygems(pkg: str, threshold_days: int) -> dict:
    data = fetch_json(f"https://rubygems.org/api/v1/gems/{pkg}.json")
    if not data:
        return {"status": "warn", "package": pkg, "ecosystem": "rubygems", "reason": "could not fetch from RubyGems"}

    latest = data.get("version", "")
    version_created = data.get("version_created_at", "")

    if not version_created:
        return {"status": "ok", "package": pkg, "ecosystem": "rubygems", "version": latest, "age_days": -1}

    pub = datetime.fromisoformat(version_created.replace("Z", "+00:00"))
    age_days = (datetime.now(timezone.utc) - pub).days

    result = {
        "package": pkg, "ecosystem": "rubygems", "version": latest,
        "age_days": age_days, "publish_date": version_created,
    }

    if age_days < threshold_days:
        result["status"] = "flagged"
        # Get version history for fallback
        versions_data = fetch_json(f"https://rubygems.org/api/v1/versions/{pkg}.json")
        fallback = ""
        if versions_data:
            threshold = timedelta(days=threshold_days)
            now = datetime.now(timezone.utc)
            safe = []
            for v in versions_data:
                vnum = v.get("number", "")
                if v.get("prerelease"):
                    continue
                created = v.get("created_at", "")
                if created:
                    u = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    if (now - u) >= threshold:
                        safe.append((vnum, u))
            safe.sort(key=lambda x: x[1], reverse=True)
            fallback = safe[0][0] if safe else ""
        result["fallback"] = fallback
    else:
        result["status"] = "ok"

    return result


def check_packagist(pkg: str, threshold_days: int) -> dict:
    # Packagist packages are vendor/name format
    data = fetch_json(f"https://repo.packagist.org/p2/{pkg}.json")
    if not data:
        return {"status": "warn", "package": pkg, "ecosystem": "packagist", "reason": "could not fetch from Packagist"}

    packages = data.get("packages", {}).get(pkg, [])
    if not packages:
        return {"status": "warn", "package": pkg, "ecosystem": "packagist", "reason": "no versions found"}

    # Packages are sorted newest first
    # Find latest stable version
    latest_entry = None
    for p in packages:
        v = p.get("version", "")
        if v.startswith("dev-") or "alpha" in v or "beta" in v or "rc" in v.lower():
            continue
        latest_entry = p
        break

    if not latest_entry:
        latest_entry = packages[0]

    version = latest_entry.get("version", "")
    time_str = latest_entry.get("time", "")

    if not time_str:
        return {"status": "ok", "package": pkg, "ecosystem": "packagist", "version": version, "age_days": -1}

    pub = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
    age_days = (datetime.now(timezone.utc) - pub).days

    result = {
        "package": pkg, "ecosystem": "packagist", "version": version,
        "age_days": age_days, "publish_date": time_str,
    }

    if age_days < threshold_days:
        result["status"] = "flagged"
        threshold = timedelta(days=threshold_days)
        now = datetime.now(timezone.utc)
        safe = []
        for p in packages:
            v = p.get("version", "")
            if v.startswith("dev-"):
                continue
            t = p.get("time", "")
            if t:
                u = datetime.fromisoformat(t.replace("Z", "+00:00"))
                if (now - u) >= threshold:
                    safe.append((v, u))
        safe.sort(key=lambda x: x[1], reverse=True)
        result["fallback"] = safe[0][0] if safe else ""
    else:
        result["status"] = "ok"

    return result


def check_homebrew(pkg: str, threshold_days: int) -> dict:
    # Step 1: get formula metadata (version + ruby_source_path)
    is_cask = False
    data = fetch_json(f"https://formulae.brew.sh/api/formula/{pkg}.json")
    if not data:
        data = fetch_json(f"https://formulae.brew.sh/api/cask/{pkg}.json")
        is_cask = True
    if not data:
        return {"status": "warn", "package": pkg, "ecosystem": "homebrew", "reason": "could not fetch from Homebrew"}

    if is_cask:
        version = str(data.get("version", ""))
        source_path = f"Casks/{pkg[0]}/{pkg}.rb"
    else:
        version = str(data.get("versions", {}).get("stable", ""))
        source_path = data.get("ruby_source_path", "")

    # Step 2: get the last commit that touched this formula from homebrew-core
    # This gives us the real "last updated" timestamp
    repo = "Homebrew/homebrew-cask" if is_cask else "Homebrew/homebrew-core"
    commits_url = f"https://api.github.com/repos/{repo}/commits?path={urllib.parse.quote(source_path)}&per_page=5"
    commits = fetch_json(commits_url)

    if not commits or not isinstance(commits, list) or len(commits) == 0:
        return {
            "status": "ok", "package": pkg, "ecosystem": "homebrew",
            "version": version, "age_days": -1,
            "note": "could not fetch commit history",
        }

    # Latest commit = most recent formula change
    latest_commit = commits[0]
    commit_date = latest_commit["commit"]["committer"]["date"]
    commit_msg = latest_commit["commit"]["message"].split("\n")[0]
    pub = datetime.fromisoformat(commit_date.replace("Z", "+00:00"))
    age_days = (datetime.now(timezone.utc) - pub).days

    result = {
        "package": pkg, "ecosystem": "homebrew", "version": version,
        "age_days": age_days, "publish_date": commit_date,
        "last_commit": commit_msg,
    }

    if age_days < threshold_days:
        result["status"] = "flagged"
        # Find the previous commit that's old enough as fallback reference
        threshold = timedelta(days=threshold_days)
        now = datetime.now(timezone.utc)
        fallback_commit = ""
        for c in commits[1:]:
            cd = c["commit"]["committer"]["date"]
            ct = datetime.fromisoformat(cd.replace("Z", "+00:00"))
            if (now - ct) >= threshold:
                # Extract version from commit message if possible (e.g. "jq: update 1.8.0 bottle.")
                msg = c["commit"]["message"].split("\n")[0]
                # Try to find a version number in the message
                import re
                ver_match = re.search(r'(\d+\.\d+(?:\.\d+)*)', msg)
                fallback_commit = ver_match.group(1) if ver_match else f"(see commit {cd[:10]})"
                break
        result["fallback"] = fallback_commit
    else:
        result["status"] = "ok"

    return result


# ── OSV.dev Vulnerability Check ──

OSV_ECOSYSTEM_MAP = {
    "pypi": "PyPI",
    "npm": "npm",
    "cargo": "crates.io",
    "go": "Go",
    "rubygems": "RubyGems",
    "packagist": "Packagist",
    "homebrew": None,  # not in OSV
}


def check_osv(ecosystem: str, package: str, version: str = "") -> list:
    """Query OSV.dev for known vulnerabilities. Returns list of advisory dicts."""
    osv_eco = OSV_ECOSYSTEM_MAP.get(ecosystem)
    if not osv_eco:
        return []

    query = {"package": {"name": package, "ecosystem": osv_eco}}
    if version:
        query["version"] = version

    resp = post_json("https://api.osv.dev/v1/query", query)
    if not resp:
        return []

    vulns = resp.get("vulns", [])
    results = []
    for v in vulns[:10]:  # cap at 10
        results.append({
            "id": v.get("id", ""),
            "summary": v.get("summary", ""),
            "severity": _extract_severity(v),
            "published": v.get("published", ""),
            "url": f"https://osv.dev/vulnerability/{v.get('id', '')}",
        })
    return results


def _extract_severity(vuln: dict) -> str:
    """Extract severity from OSV vuln entry."""
    severities = vuln.get("severity", [])
    for s in severities:
        if s.get("type") == "CVSS_V3":
            score = s.get("score", "")
            # Parse CVSS score from vector
            if ":" in score:
                # CVSS vector string — extract base score from database_specific
                pass
    # Fall back to database_specific
    db = vuln.get("database_specific", {})
    severity = db.get("severity", "")
    if severity:
        return severity
    # Check if any affected has severity info
    for affected in vuln.get("affected", []):
        eco_specific = affected.get("ecosystem_specific", {})
        if "severity" in eco_specific:
            return eco_specific["severity"]
    return "UNKNOWN"


# ── GitHub Advisory Check ──

def check_github_advisories(ecosystem: str, package: str) -> list:
    """Check GitHub Advisory Database for known compromises/malware."""
    # GitHub Advisory Database API (public, no auth needed for search)
    eco_map = {
        "pypi": "pip",
        "npm": "npm",
        "cargo": "cargo",
        "go": "go",
        "rubygems": "rubygems",
        "packagist": "composer",
    }
    gh_eco = eco_map.get(ecosystem, "")
    if not gh_eco:
        return []

    # Use the GitHub Advisory Database API
    url = f"https://api.github.com/advisories?ecosystem={gh_eco}&affects={urllib.parse.quote(package, safe='')}&per_page=5"
    data = fetch_json(url)
    if not data or not isinstance(data, list):
        return []

    results = []
    for adv in data[:5]:
        results.append({
            "ghsa_id": adv.get("ghsa_id", ""),
            "summary": adv.get("summary", ""),
            "severity": adv.get("severity", ""),
            "type": adv.get("type", ""),  # "reviewed" or "malware"
            "published": adv.get("published_at", ""),
            "url": adv.get("html_url", ""),
        })
    return results


# ── Unified check ──

ECOSYSTEM_CHECKERS = {
    "pypi": check_pypi,
    "npm": check_npm,
    "cargo": check_crates,
    "go": check_go,
    "rubygems": check_rubygems,
    "packagist": check_packagist,
    "homebrew": check_homebrew,
}


def full_check(ecosystem: str, package: str, threshold_days: int = 7) -> dict:
    """Run all checks for a single package: recency + OSV + GitHub advisories."""
    checker = ECOSYSTEM_CHECKERS.get(ecosystem)
    if not checker:
        return {
            "status": "warn", "package": package, "ecosystem": ecosystem,
            "reason": f"unsupported ecosystem: {ecosystem}",
        }

    # Recency check
    result = checker(package, threshold_days)

    # OSV vulnerability check
    version = result.get("version", "")
    osv_vulns = check_osv(ecosystem, package, version)
    if osv_vulns:
        result["vulnerabilities"] = osv_vulns
        result["vuln_count"] = len(osv_vulns)
        # Elevate status if there are critical/high vulns
        for v in osv_vulns:
            sev = v.get("severity", "").upper()
            if sev in ("CRITICAL", "HIGH") or v.get("type") == "malware":
                result["status"] = "flagged"
                result["vuln_critical"] = True
                break

    # GitHub Advisory check (catches malware specifically)
    gh_advisories = check_github_advisories(ecosystem, package)
    if gh_advisories:
        result["advisories"] = gh_advisories
        for adv in gh_advisories:
            if adv.get("type") == "malware":
                result["status"] = "flagged"
                result["known_malware"] = True
                result.setdefault("reason", "")
                result["reason"] = f"KNOWN MALWARE: {adv.get('summary', 'see advisory')}"
                break

    return result


# ── CLI ──

def main():
    if len(sys.argv) < 2:
        print("Usage: scanner.py <check|check-multi|osv|advisories> ...", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    threshold = 7

    # Parse --threshold from anywhere in args
    args = sys.argv[2:]
    filtered_args = []
    i = 0
    while i < len(args):
        if args[i] == "--threshold" and i + 1 < len(args):
            threshold = int(args[i + 1])
            i += 2
        else:
            filtered_args.append(args[i])
            i += 1

    if cmd == "check":
        if len(filtered_args) < 2:
            print("Usage: scanner.py check <ecosystem> <package> [--threshold N]", file=sys.stderr)
            sys.exit(1)
        ecosystem, package = filtered_args[0], filtered_args[1]
        result = full_check(ecosystem, package, threshold)
        print(json.dumps(result))

    elif cmd == "check-multi":
        if len(filtered_args) < 2:
            print("Usage: scanner.py check-multi <ecosystem> <pkg1> [pkg2 ...] [--threshold N]", file=sys.stderr)
            sys.exit(1)
        ecosystem = filtered_args[0]
        packages = filtered_args[1:]
        results = []
        for pkg in packages:
            results.append(full_check(ecosystem, pkg, threshold))
        print(json.dumps(results))

    elif cmd == "osv":
        if len(filtered_args) < 2:
            print("Usage: scanner.py osv <ecosystem> <package> [version]", file=sys.stderr)
            sys.exit(1)
        ecosystem, package = filtered_args[0], filtered_args[1]
        version = filtered_args[2] if len(filtered_args) > 2 else ""
        result = check_osv(ecosystem, package, version)
        print(json.dumps(result))

    elif cmd == "advisories":
        if len(filtered_args) < 2:
            print("Usage: scanner.py advisories <ecosystem> <package>", file=sys.stderr)
            sys.exit(1)
        ecosystem, package = filtered_args[0], filtered_args[1]
        result = check_github_advisories(ecosystem, package)
        print(json.dumps(result))

    elif cmd == "scan-actions":
        # Scan a directory for GitHub Actions workflow files
        scan_dir = filtered_args[0] if filtered_args else "."
        results = scan_github_actions(scan_dir, threshold)
        print(json.dumps(results))

    elif cmd == "check-action":
        # Check a single GitHub Action reference
        if len(filtered_args) < 1:
            print("Usage: scanner.py check-action <owner/repo@ref> [--threshold N]", file=sys.stderr)
            sys.exit(1)
        result = check_single_action(filtered_args[0], threshold)
        print(json.dumps(result))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


# ── GitHub Actions Scanner ──

def parse_workflow_actions(filepath: str) -> list:
    """Extract `uses:` references from a GitHub Actions workflow YAML file.
    Parses without PyYAML — just regex on `uses:` lines."""
    import re
    actions = []
    try:
        with open(filepath) as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if line.startswith("#"):
                    continue
                match = re.search(r'uses:\s*["\']?([^"\'#\s]+)', line)
                if match:
                    ref = match.group(1)
                    actions.append({"ref": ref, "file": filepath, "line": lineno})
    except Exception as e:
        print(f"[avcp] Failed to parse {filepath}: {e}", file=sys.stderr)
    return actions


def parse_action_ref(ref: str) -> dict:
    """Parse 'owner/repo@ref' or 'owner/repo/path@ref' into components."""
    if "@" not in ref:
        return {"owner_repo": ref, "path": "", "ref": "", "type": "unpinned"}

    parts, pinned_ref = ref.rsplit("@", 1)
    segments = parts.split("/", 2)
    owner_repo = "/".join(segments[:2]) if len(segments) >= 2 else parts
    sub_path = segments[2] if len(segments) > 2 else ""

    # Determine ref type
    import re
    if re.match(r'^[0-9a-f]{40}$', pinned_ref):
        ref_type = "sha"
    elif re.match(r'^v?\d+(\.\d+)*$', pinned_ref):
        ref_type = "tag"
    else:
        ref_type = "branch"

    return {
        "owner_repo": owner_repo,
        "path": sub_path,
        "ref": pinned_ref,
        "type": ref_type,
    }


def check_single_action(action_ref: str, threshold_days: int = 7) -> dict:
    """Check a single GitHub Action for recency, pinning, and known issues."""
    parsed = parse_action_ref(action_ref)
    owner_repo = parsed["owner_repo"]
    ref = parsed["ref"]
    ref_type = parsed["type"]

    result = {
        "action": action_ref,
        "owner_repo": owner_repo,
        "ref": ref,
        "ref_type": ref_type,
        "status": "ok",
        "flags": [],
    }

    # Flag: not pinned to SHA
    if ref_type != "sha":
        result["flags"].append({
            "type": "not_sha_pinned",
            "severity": "medium",
            "detail": f"Pinned to {ref_type} '{ref}' — mutable, could be force-pushed. Pin to a full SHA for immutability.",
        })

    # Skip further checks for docker:// or local actions
    if owner_repo.startswith("docker://") or owner_repo.startswith("./"):
        return result

    # Get the commit/tag info from GitHub API
    if ref_type == "sha":
        commit_data = fetch_json(f"https://api.github.com/repos/{owner_repo}/commits/{ref}")
        if commit_data:
            commit_date = commit_data.get("commit", {}).get("committer", {}).get("date", "")
            if commit_date:
                from datetime import datetime, timezone, timedelta
                pub = datetime.fromisoformat(commit_date.replace("Z", "+00:00"))
                age_days = (datetime.now(timezone.utc) - pub).days
                result["commit_date"] = commit_date
                result["age_days"] = age_days
                if age_days < threshold_days:
                    result["flags"].append({
                        "type": "recent_commit",
                        "severity": "high",
                        "detail": f"SHA points to a commit from {age_days}d ago — recently modified.",
                    })
                    result["status"] = "flagged"
    elif ref_type == "tag":
        # Check the tag's commit date
        tag_data = fetch_json(f"https://api.github.com/repos/{owner_repo}/git/ref/tags/{ref}")
        if tag_data:
            tag_sha = tag_data.get("object", {}).get("sha", "")
            obj_type = tag_data.get("object", {}).get("type", "")
            # If annotated tag, resolve to commit
            if obj_type == "tag" and tag_sha:
                tag_obj = fetch_json(f"https://api.github.com/repos/{owner_repo}/git/tags/{tag_sha}")
                if tag_obj:
                    tag_sha = tag_obj.get("object", {}).get("sha", tag_sha)
            if tag_sha:
                commit_data = fetch_json(f"https://api.github.com/repos/{owner_repo}/commits/{tag_sha}")
                if commit_data:
                    commit_date = commit_data.get("commit", {}).get("committer", {}).get("date", "")
                    if commit_date:
                        from datetime import datetime, timezone, timedelta
                        pub = datetime.fromisoformat(commit_date.replace("Z", "+00:00"))
                        age_days = (datetime.now(timezone.utc) - pub).days
                        result["commit_date"] = commit_date
                        result["age_days"] = age_days
                        result["resolved_sha"] = tag_sha
                        if age_days < threshold_days:
                            result["flags"].append({
                                "type": "recent_tag",
                                "severity": "high",
                                "detail": f"Tag '{ref}' points to a commit from {age_days}d ago.",
                            })
                            result["status"] = "flagged"
    elif ref_type == "branch":
        result["flags"].append({
            "type": "branch_ref",
            "severity": "high",
            "detail": f"Pinned to branch '{ref}' — changes on every push. Extremely unsafe.",
        })
        result["status"] = "flagged"

    # Check if the repo has any security advisories
    advisories = fetch_json(f"https://api.github.com/repos/{owner_repo}/security-advisories?per_page=5")
    if advisories and isinstance(advisories, list) and len(advisories) > 0:
        result["flags"].append({
            "type": "has_advisories",
            "severity": "medium",
            "detail": f"Repo has {len(advisories)} security advisor(y/ies).",
        })
        result["advisories"] = [
            {"id": a.get("ghsa_id", ""), "summary": a.get("summary", "")[:100]}
            for a in advisories[:3]
        ]

    # Determine overall status
    severities = [f["severity"] for f in result["flags"]]
    if "high" in severities:
        result["status"] = "flagged"
    elif "medium" in severities and result["status"] == "ok":
        result["status"] = "warn"

    return result


def scan_github_actions(directory: str, threshold_days: int = 7) -> dict:
    """Scan all workflow files in a directory for GitHub Actions issues."""
    import os
    import glob

    workflows_dir = os.path.join(directory, ".github", "workflows")
    if not os.path.isdir(workflows_dir):
        return {"status": "skip", "reason": "No .github/workflows/ directory found", "actions": []}

    workflow_files = glob.glob(os.path.join(workflows_dir, "*.yml")) + \
                     glob.glob(os.path.join(workflows_dir, "*.yaml"))

    if not workflow_files:
        return {"status": "skip", "reason": "No workflow files found", "actions": []}

    all_actions = []
    for wf in workflow_files:
        all_actions.extend(parse_workflow_actions(wf))

    # Deduplicate by ref
    seen = set()
    unique_actions = []
    for a in all_actions:
        if a["ref"] not in seen:
            seen.add(a["ref"])
            unique_actions.append(a)

    results = []
    flagged_count = 0
    warn_count = 0

    for action in unique_actions:
        check = check_single_action(action["ref"], threshold_days)
        check["file"] = action["file"]
        check["line"] = action["line"]
        results.append(check)
        if check["status"] == "flagged":
            flagged_count += 1
        elif check["status"] == "warn":
            warn_count += 1

    return {
        "status": "flagged" if flagged_count > 0 else ("warn" if warn_count > 0 else "ok"),
        "total_actions": len(unique_actions),
        "flagged": flagged_count,
        "warnings": warn_count,
        "actions": results,
    }


if __name__ == "__main__":
    main()
