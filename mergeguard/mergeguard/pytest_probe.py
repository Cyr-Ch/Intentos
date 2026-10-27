"""Trusted pytest observer used by the guardian; records exact failing node IDs."""
import json
import os
from pathlib import Path

failures = set()
collection_errors = []
collected = 0


def pytest_runtest_logreport(report):
    if report.failed:
        failures.add(report.nodeid)


def pytest_collectreport(report):
    if report.failed:
        collection_errors.append(report.nodeid)


def pytest_collection_finish(session):
    global collected
    collected = len(session.items)


def pytest_sessionfinish(session, exitstatus):
    target = os.environ.get("MERGEGUARD_TEST_RESULT")
    if target:
        Path(target).write_text(json.dumps({"failed": sorted(failures), "collection_errors": collection_errors,
                                          "collected": collected, "exit_code": int(exitstatus)}))
