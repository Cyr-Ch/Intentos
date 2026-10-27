"""Acceptance tests for T07, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d24-544f-7431-80c7-4ae1dae712e5).

Base revision 6757f4f659, 2026-10-27T11:35:48.862Z. At that revision: test_add_weekdays_uses_a_non_deprecated_datetime_accessor failed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Reviewer edit (2026-10-27): the generated module asserted weekdays for an index that never left Sunday 31 December; the index now spans into the 1 January holiday and the expected sequence was corrected.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Calling the named weekday-assignment helper does not emit the DatetimeIndex.weekday DeprecationWarning.
- Weekdays remain numbered Monday=1 through Sunday=7, while supplied holidays remain 0.

Ticket:
    DeprecationWarning from DatetimeIndex.weekday when building profiles
    
    With the current pandas, building any profile prints
    `DatetimeIndex.weekday is deprecated and will be removed in a future version`, coming from the weekday
    assignment in `tools.add_weekdays2df`. Our CI runs with warnings as errors, so this breaks the build.
    
    Please use the supported accessor. Weekday numbering (1 = Monday ... 7 = Sunday, 0 = holiday) must not change.
"""
import datetime
import warnings

import pandas as pd

from oemof.demand.tools import add_weekdays2df


def test_add_weekdays_uses_a_non_deprecated_datetime_accessor():
    # Sunday 31 December 2023, 20:00 to 23:00, then the New Year holiday, 00:00 to 03:00.
    index = pd.date_range("2023-12-31 20:00", periods=8, freq="h")
    dataframe = pd.DataFrame(index=index)

    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        result = add_weekdays2df(
            dataframe,
            holidays=[datetime.date(2024, 1, 1)],
        )

    assert result["weekday"].tolist() == [7, 7, 7, 7, 0, 0, 0, 0]
