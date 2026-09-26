# ABOUTME: CLI wrapper around JobSpy's scrape_jobs, invoked per search by the
# ABOUTME: MCP server; prints one JSON array of postings on stdout.
import csv
import argparse
import ast
import json
import sys
from jobspy import scrape_jobs

# JobSpy aborts the ENTIRE scrape when one posting carries a location it cannot
# parse — a `nepal`-located remote listing is enough — which is fatal at the
# volume this runs at: one bad row costs a whole search. Fall back to a
# permissive value instead of raising.
#
# The patch targets the IMPORTED object, not the installed package files, so
# `pip install -U python-jobspy` is unaffected and keeps the scraping rules
# current.
try:
    import jobspy.model as _jobspy_model

    _original_from_string = _jobspy_model.Country.from_string

    def _tolerant_from_string(country_str, *args, **kwargs):
        try:
            return _original_from_string(country_str, *args, **kwargs)
        except Exception:  # noqa: BLE001
            print(f"unrecognized country {country_str!r}; falling back to WORLDWIDE",
                  file=sys.stderr)
            for name in ("WORLDWIDE", "WORLD_WIDE", "US", "USA"):
                fallback = getattr(_jobspy_model.Country, name, None)
                if fallback is not None:
                    return fallback
            raise

    _jobspy_model.Country.from_string = staticmethod(_tolerant_from_string)
except Exception as _patch_error:  # noqa: BLE001
    # Reported, never silent: without the patch one unparseable location can
    # still take a whole search down, and that must be visible in the log.
    print(f"could not patch Country.from_string: {_patch_error}", file=sys.stderr)

def parse_args():
    parser = argparse.ArgumentParser(description='Scrape jobs from various sites')
    parser.add_argument('--site_name', default="indeed", 
                        help='Comma-separated list of sites to scrape: indeed,linkedin,zip_recruiter,glassdoor,google,bayt,naukri')
    parser.add_argument('--search_term', default="software engineer", 
                        help='Search term for jobs')
    parser.add_argument('--google_search_term', default="software engineer jobs near San Francisco, CA since yesterday", 
                        help='Google specific search term')
    parser.add_argument('--location', default="San Francisco, CA", 
                        help='Location for job search')
    parser.add_argument('--distance', type=int, default=50,
                        help='Distance in miles (default: 50)')
    parser.add_argument('--job_type', choices=['fulltime', 'parttime', 'internship', 'contract'],
                        help='Type of job (fulltime, parttime, internship, contract)')
    parser.add_argument('--results_wanted', type=int, default=20, 
                        help='Number of results wanted')
    parser.add_argument('--easy_apply', action='store_true',
                        help='Filter for jobs that are hosted on the job board site')
    parser.add_argument('--description_format', default='markdown', choices=['markdown', 'html'],
                        help='Format type of the job descriptions (default: markdown)')
    parser.add_argument('--offset', type=int, default=0,
                        help='Starts the search from an offset')
    parser.add_argument('--hours_old', type=int, default=72, 
                        help='How many hours old the jobs can be')
    parser.add_argument('--verbose', type=int, default=2, choices=[0, 1, 2],
                        help='Controls verbosity (0=errors only, 1=errors+warnings, 2=all logs)')
    parser.add_argument('--country_indeed', default='USA', 
                        help='Country for Indeed search')
    parser.add_argument('--is_remote', action='store_true',
                        help='Whether to search for remote jobs only')
    parser.add_argument('--linkedin_fetch_description', action='store_true', 
                        help='Fetch LinkedIn job descriptions (slower)')
    parser.add_argument('--linkedin_company_ids', 
                        help='Comma-separated list of LinkedIn company IDs')
    parser.add_argument('--enforce_annual_salary', action='store_true',
                        help='Converts wages to annual salary')
    parser.add_argument('--proxies', 
                        help='Comma-separated list of proxies')
    parser.add_argument('--ca_cert',
                        help='Path to CA Certificate file for proxies')
    parser.add_argument('--output', 
                        help='Output file path without extension. If not provided, outputs to stdout')
    parser.add_argument('--format', default="json", choices=['csv', 'json'],
                        help='Output format (csv or json)')
    return parser.parse_args()

args = parse_args()

# Convert comma-separated string to list
site_names = args.site_name.split(',')

# Parse proxies if provided
proxies = args.proxies.split(',') if args.proxies else None

# Parse LinkedIn company IDs if provided
linkedin_company_ids = [int(id) for id in args.linkedin_company_ids.split(',')] if args.linkedin_company_ids else None

jobs = scrape_jobs(
    site_name=site_names,
    search_term=args.search_term,
    google_search_term=args.google_search_term,
    location=args.location,
    distance=args.distance,
    job_type=args.job_type,
    results_wanted=args.results_wanted,
    easy_apply=args.easy_apply,
    description_format=args.description_format,
    offset=args.offset,
    hours_old=args.hours_old,
    verbose=args.verbose,
    country_indeed=args.country_indeed,
    is_remote=args.is_remote,
    linkedin_fetch_description=args.linkedin_fetch_description,
    linkedin_company_ids=linkedin_company_ids,
    enforce_annual_salary=args.enforce_annual_salary,
    proxies=proxies,
    ca_cert=args.ca_cert,
)
# print(f"Found {len(jobs)} jobs", file=sys.stderr)

# Output based on selected format
if args.output:
    # Output to file
    output_file = f"{args.output}.{args.format}"
    if args.format == "csv":
        print(jobs.head(), file=output_file)
        jobs.to_csv(output_file, quoting=csv.QUOTE_NONNUMERIC, escapechar="\\", index=False)
        print(f"Jobs saved to {output_file}")
    elif args.format == "json":
        jobs.to_json(output_file, orient="records", indent=2)
        print(f"Jobs saved to {output_file}")
else:
    # Output to stdout
    if args.format == "csv":
        jobs.to_csv(sys.stdout, quoting=csv.QUOTE_NONNUMERIC, escapechar="\\", index=False)
    elif args.format == "json":
        print(jobs.to_json(orient="records", indent=2))
