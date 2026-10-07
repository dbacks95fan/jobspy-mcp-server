# ABOUTME: Fetches job descriptions per URL for postings a metadata-only search
# ABOUTME: kept — LinkedIn via JobSpy's own parser, Indeed via its GraphQL API.
# Copyright (c) 2026 DPSystems, LLC. All rights reserved.
"""Reads one JSON batch on stdin, writes one JSON array on stdout.

stdin:  {"jobs": [{"id": ..., "url": ...}], "descriptionFormat": "markdown",
         "includeMetadata": false, "proxies": "http://user:pass@host:port"}
stdout: [{"id", "description", "source", "error", "title", "company"}, ...]

`source` is `linkedin_fetch` | `indeed_fetch` | `unavailable`. An entry is
ALWAYS emitted for every input id: "could not be read" and "has no text" are
different facts, and a missing entry would be read as the second.

Both boards are fetchable per-URL, so a stash miss is not fatal. Indeed-by-URL
was long documented as impossible because JobSpy implements only `jobSearch(...)`
— true of JobSpy's functions and false of the API. `jobData(input: {jobKeys:})`
against the *same* endpoint and bundled key JobSpy already authenticates with
returns full descriptions plus title/employer, three keys in ONE request,
sub-second.

We never hand-parse a description: `pip install -U python-jobspy` is what keeps
the scraping rules current, so every path here goes through the library's own
parser or the board's own API.
"""
import json
import re
import sys
import traceback

UNAVAILABLE = "unavailable"

# Indeed's GraphQL takes up to this many job keys per request. Conservative: the
# measured call used three, and a rejected oversized batch would lose every
# posting in it rather than the surplus.
INDEED_BATCH = 10


def _err(exc) -> str:
    return f"{type(exc).__name__}: {exc}"[:300]


def _proxy_dict(proxies):
    """requests-style mapping, or None. JobSpy takes a list; requests takes a
    dict, and the two paths below need different shapes of the same value."""
    if not proxies:
        return None
    first = proxies.split(",")[0].strip() if isinstance(proxies, str) else proxies[0]
    if not first:
        return None
    return {"http": first, "https": first}


def _is_linkedin(url: str) -> bool:
    return "linkedin.com" in (url or "")


def _is_indeed(url: str) -> bool:
    return "indeed.com" in (url or "")


def _indeed_job_key(url: str):
    """The `jk` a posting's URL carries, which is what `jobData` takes."""
    match = re.search(r"[?&]jk=([0-9a-fA-F]+)", url or "")
    if match:
        return match.group(1)
    # Some rows carry the viewjob path form instead.
    match = re.search(r"/viewjob/([0-9a-fA-F]+)", url or "")
    return match.group(1) if match else None


# ---------------------------------------------------------------- LinkedIn


def _linkedin_fetch(jobs, proxies, description_format, include_metadata):
    """One request per posting through JobSpy's own `_get_job_details`.

    Serial on purpose: these go through the proxy pool, and LinkedIn answers a
    saturated pool with a fast failure rather than an error, so widening this
    turns recoverable misses into a batch of them.
    """
    out = []
    try:
        from jobspy.linkedin import LinkedIn
    except Exception as exc:  # noqa: BLE001
        # A library layout change must be reported, not guessed around — the
        # alternative is hand-parsing LinkedIn here, which is exactly what
        # keeping JobSpy updated is supposed to avoid.
        for job in jobs:
            out.append({"id": job["id"], "description": None, "source": UNAVAILABLE,
                        "error": f"JobSpy LinkedIn parser unavailable: {_err(exc)}",
                        "title": "", "company": ""})
        return out

    # Unproxied is a blocked path, not a degraded one: LinkedIn blocks a home
    # IP quickly, and the server's proxy invariant forbids a direct request.
    proxy = (_proxy_dict(proxies.strip() if isinstance(proxies, str) else proxies) or {}).get("https")
    if not proxy:
        for job in jobs:
            out.append({"id": job["id"], "description": None, "source": UNAVAILABLE,
                        "error": "no proxy configured; LinkedIn is never fetched directly",
                        "title": "", "company": ""})
        return out

    from jobspy.model import DescriptionFormat, ScraperInput, Site

    # The proxy goes to the CONSTRUCTOR: JobSpy builds its HTTP session there,
    # so assigning `scraper.proxies` afterwards (as this used to) changed
    # nothing and every request went out unproxied.
    scraper = LinkedIn(proxies=proxy)
    # `_get_job_details` reads `scraper_input.description_format` whenever
    # LinkedIn returns a description. A full JobSpy search sets it; calling the
    # method directly does not, and without this every SUCCESSFUL fetch raised
    # AttributeError and was reported as unavailable (first live run, 2026-10-07).
    scraper.scraper_input = ScraperInput(
        site_type=[Site.LINKEDIN],
        description_format=DescriptionFormat(description_format or "markdown"))

    for job in jobs:
        try:
            details = scraper._get_job_details(  # noqa: SLF001
                job_id=_linkedin_job_id(job["url"]))
            description = (details or {}).get("description") or None
            row = {"id": job["id"], "description": description,
                   "source": "linkedin_fetch" if description else UNAVAILABLE,
                   "error": None if description else "LinkedIn returned no description",
                   "title": "", "company": ""}
            if include_metadata:
                row["title"] = (details or {}).get("job_title") or ""
                company = (details or {}).get("company") or ""
                row["company"] = getattr(company, "name", company) or ""
            out.append(row)
        except Exception as exc:  # noqa: BLE001
            out.append({"id": job["id"], "description": None,
                        "source": UNAVAILABLE, "error": _err(exc),
                        "title": "", "company": ""})
    return out


def _linkedin_job_id(url: str) -> str:
    """LinkedIn's numeric posting id, which is what `_get_job_details` takes."""
    match = re.search(r"/jobs/view/(?:[^/]*-)?(\d+)", url or "")
    if match:
        return match.group(1)
    match = re.search(r"currentJobId=(\d+)", url or "")
    if match:
        return match.group(1)
    # Last resort: a trailing run of digits.
    match = re.search(r"(\d{6,})", url or "")
    if not match:
        raise ValueError(f"no LinkedIn job id in URL: {url}")
    return match.group(1)


# ------------------------------------------------------------------ Indeed


def _indeed_fetch(jobs, proxies, description_format, include_metadata):
    """Batched `jobData(input: {jobKeys: [...]})` against apis.indeed.com.

    The endpoint and the bundled API key are the ones JobSpy already
    authenticates with for search, so this adds no new credential and no new
    dependency.
    """
    out = []
    try:
        import requests
        from jobspy.indeed.constant import api_headers
    except Exception as exc:  # noqa: BLE001
        for job in jobs:
            out.append({"id": job["id"], "description": None, "source": UNAVAILABLE,
                        "error": f"Indeed API constants unavailable: {_err(exc)}",
                        "title": "", "company": ""})
        return out

    by_key = {}
    for job in jobs:
        key = _indeed_job_key(job["url"])
        if key:
            by_key.setdefault(key, []).append(job["id"])
        else:
            out.append({"id": job["id"], "description": None,
                        "source": UNAVAILABLE,
                        "error": f"no Indeed job key in URL: {job['url']}",
                        "title": "", "company": ""})

    keys = list(by_key)
    markdown = (description_format or "markdown") == "markdown"
    for start in range(0, len(keys), INDEED_BATCH):
        chunk = keys[start:start + INDEED_BATCH]
        try:
            payload = {"query": _INDEED_QUERY % json.dumps(chunk)}
            resp = requests.post("https://apis.indeed.com/graphql",
                                 headers=dict(api_headers), json=payload,
                                 proxies=_proxy_dict(proxies), timeout=60)
            resp.raise_for_status()
            results = (resp.json().get("data") or {}).get("jobData") or {}
            found = {}
            for item in results.get("results") or []:
                job_node = item.get("job") or {}
                key = job_node.get("key")
                body = (job_node.get("description") or {})
                text = body.get("html") if not markdown else body.get("text")
                text = text or body.get("html") or body.get("text")
                found[key] = (text or None, job_node)
            for key in chunk:
                text, node = found.get(key, (None, {}))
                for job_id in by_key[key]:
                    row = {"id": job_id, "description": text,
                           "source": "indeed_fetch" if text else UNAVAILABLE,
                           "error": None if text else "Indeed returned no description",
                           "title": "", "company": ""}
                    if include_metadata:
                        row["title"] = node.get("title") or ""
                        row["company"] = ((node.get("employer") or {}).get("name")
                                          or "")
                    out.append(row)
        except Exception as exc:  # noqa: BLE001
            reason = _err(exc)
            for key in chunk:
                for job_id in by_key[key]:
                    out.append({"id": job_id, "description": None,
                                "source": UNAVAILABLE, "error": reason,
                                "title": "", "company": ""})
    return out


# `jobData` returns the description alongside title and employer, which is what
# makes includeMetadata free on this board.
_INDEED_QUERY = """
query GetJobData {
  jobData(input: { jobKeys: %s }) {
    results {
      job {
        key
        title
        description { html text }
        employer { name }
      }
    }
  }
}
"""


def main() -> int:
    try:
        # `utf-8-sig`, not plain utf-8: a BOM on the batch would otherwise fail
        # the parse and lose every posting in it. Same trap `company-search.csv`
        # already documents — there a BOM silently emptied every row.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps([]), flush=True)
        print(f"could not read the batch on stdin: {_err(exc)}", file=sys.stderr)
        return 1

    jobs = [j for j in (payload.get("jobs") or []) if j.get("id") and j.get("url")]
    proxies = payload.get("proxies")
    description_format = payload.get("descriptionFormat", "markdown")
    include_metadata = bool(payload.get("includeMetadata"))

    linkedin = [j for j in jobs if _is_linkedin(j["url"])]
    indeed = [j for j in jobs if _is_indeed(j["url"])]
    neither = [j for j in jobs if not _is_linkedin(j["url"]) and not _is_indeed(j["url"])]

    rows = []
    if linkedin:
        rows += _linkedin_fetch(linkedin, proxies, description_format, include_metadata)
    if indeed:
        rows += _indeed_fetch(indeed, proxies, description_format, include_metadata)
    for job in neither:
        # A careers-page or ATS URL belongs to `jd_extractor` in the tailor
        # agent, not here. Saying which is the difference between a caller that
        # can route around this and one that reports a phantom outage.
        rows.append({"id": job["id"], "description": None, "source": UNAVAILABLE,
                     "error": "URL is on neither LinkedIn nor Indeed; "
                              "this fetcher serves those two boards only",
                     "title": "", "company": ""})

    print(json.dumps(rows), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        print(json.dumps([]), flush=True)
        sys.exit(1)
