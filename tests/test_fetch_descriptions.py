# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Tests jobspy/fetch_descriptions.py's LinkedIn path against JobSpy's REAL parser,
# ABOUTME: with only the network session faked: proxying, parsing, and refusing without a proxy.
"""
The Node tests replace this Python script with a stub, so until these existed
nothing ran it. Two bugs lived in that gap and reached the first live run
(2026-10-07):

  * The scraper was built with no proxy and `scraper.proxies` set afterwards.
    JobSpy builds its HTTP session in the constructor, so the late assignment
    changed nothing and every LinkedIn description request went out unproxied.
  * `scraper_input` was never set. JobSpy reads `scraper_input.description_format`
    whenever LinkedIn DOES return a description, so every successful fetch
    raised AttributeError and was reported as unavailable.

Run inside the MCP server image (it has python-jobspy):
  python3 tests/test_fetch_descriptions.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "jobspy", "fetch_descriptions.py")

spec = importlib.util.spec_from_file_location("fetch_descriptions", SCRIPT)
fd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd)

import jobspy.linkedin as jl

PROXY = "http://user:pass@gate.example.com:7000"
PAGE = (
    "<html><body>"
    '<div class="show-more-less-html__markup"><p>Lead a team of <b>eight</b> engineers.</p></div>'
    "</body></html>"
)
FAILS = []


def check(name, cond, detail=""):
    print(
        ("  ok    " if cond else "  FAIL  ")
        + name
        + (f"  [{detail}]" if detail and not cond else "")
    )
    if not cond:
        FAILS.append(name)


class FakeResponse:
    def __init__(self, text):
        self.text = text
        self.url = "https://www.linkedin.com/jobs/view/123"
        self.status_code = 200

    def raise_for_status(self):
        return None


class FakeSession:
    def __init__(self):
        self.headers = {}
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(url)
        return FakeResponse(PAGE)


def with_fake_network(fn):
    """Swap JobSpy's session factory for one that records the proxies it was
    given and serves a canned job page; restore it afterwards."""
    made = []
    real = jl.create_session

    def fake_create_session(*args, **kwargs):
        s = FakeSession()
        made.append({"proxies": kwargs.get("proxies"), "session": s})
        return s

    jl.create_session = fake_create_session
    try:
        return fn(), made
    finally:
        jl.create_session = real


JOBS = [{"id": "li-1", "url": "https://www.linkedin.com/jobs/view/123"}]

print("== a LinkedIn description comes back, through the proxy")
rows, made = with_fake_network(
    lambda: fd._linkedin_fetch(JOBS, PROXY, "markdown", False)
)
check("one row per posting", len(rows) == 1, rows)
row = rows[0]
check(
    "the description is returned, not marked unavailable",
    row["source"] == "linkedin_fetch" and row["description"],
    row,
)
check(
    "the page text made it through JobSpy's parser",
    "eight" in (row["description"] or ""),
    row,
)
check("no error recorded", row["error"] is None, row["error"])
check(
    "the session that made the request was built WITH the proxy",
    made and PROXY in str(made[-1]["proxies"]),
    made and made[-1]["proxies"],
)
check(
    "and that session is the one that fetched", made and made[-1]["session"].calls, made
)

print("== the description format is honoured")
rows, _ = with_fake_network(lambda: fd._linkedin_fetch(JOBS, PROXY, "html", False))
check(
    "html stays html", "<p>" in (rows[0]["description"] or ""), rows[0]["description"]
)
rows, _ = with_fake_network(lambda: fd._linkedin_fetch(JOBS, PROXY, "markdown", False))
check(
    "markdown is not html",
    "<p>" not in (rows[0]["description"] or ""),
    rows[0]["description"],
)

print("== no proxy means no request at all")
for empty in (None, "", "  "):
    rows, made = with_fake_network(
        lambda e=empty: fd._linkedin_fetch(JOBS, e, "markdown", False)
    )
    check(
        f"proxies={empty!r}: refused",
        rows[0]["source"] == fd.UNAVAILABLE and "proxy" in (rows[0]["error"] or ""),
        rows[0],
    )
    check(
        f"proxies={empty!r}: LinkedIn never contacted",
        all(not m["session"].calls for m in made),
        made,
    )

print()
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED")
sys.exit(1 if FAILS else 0)
