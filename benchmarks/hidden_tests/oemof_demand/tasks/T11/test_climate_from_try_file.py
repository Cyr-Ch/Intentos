"""Acceptance tests for T11, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d27-3c45-7300-b181-e527453e55f0).

Base revision 6757f4f659, 2026-10-27T11:39:56.315Z. At that revision: test_from_try_data_loads_a_user_supplied_dwd_try_file failed, test_from_try_data_keeps_the_dwd_header_validation_for_a_file failed, test_from_try_data_rejects_invalid_region_numbers passed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Loads temperature and cloud-cover categories from a user-supplied DWD TRY file passed to Climate.from_try_data.
- Uses the TRY region encoded in the supplied file to select the corresponding VDI energy factors.
- Preserves DWD file header validation for supplied files.
- Preserves rejection of invalid numeric TRY regions.

Ticket:
    Load VDI climate data from a user-supplied DWD TRY file
    
    `Climate.from_try_data(try_region)` only loads the TRY files shipped with the package. We have newer TRY 2045
    files from the DWD in the same format and want to use them.
    
    Please allow passing a path to a DWD TRY file instead of a region number. The existing header check and the
    region-number validation should keep behaving the same when a number is given.
"""
import datetime

import pandas as pd
import pytest

from oemof.demand.vdi import Climate


def _write_try_file(path):
    lines = [
        "Synthetic DWD TRY data\n",
        "RG IS MM DD HH N WR WG t p x RF W B D IK A E IL\n",
        "***\n",
    ]
    first_day = datetime.date(2010, 1, 1)
    for day_offset in range(365):
        day = first_day + datetime.timedelta(days=day_offset)
        temperature = -2.5 if day_offset == 0 else 7.5
        cloud_cover = 4 if day_offset == 0 else 5
        for hour in range(1, 25):
            lines.append(
                f"4 1 {day.month} {day.day} {hour} {cloud_cover} "
                f"0 0 {temperature} 1000 0 0 0 0 0 0 0 0 0\n"
            )
    path.write_text("".join(lines))


def test_from_try_data_loads_a_user_supplied_dwd_try_file(tmp_path):
    weather_file = tmp_path / "future_try.dat"
    _write_try_file(weather_file)

    climate = Climate().from_try_data(str(weather_file))

    assert climate.temperature.loc[pd.Timestamp("2010-01-01")] == -2.5
    assert climate.temperature.loc[pd.Timestamp("2010-01-02")] == 7.5
    assert climate.cloud_coverage.loc[pd.Timestamp("2010-01-01")] == "H"
    assert climate.cloud_coverage.loc[pd.Timestamp("2010-01-02")] == "B"
    assert climate.energy_factors.loc[("EFH", "F_Heiz_TT"), "UWH"] == pytest.approx(
        0.0018613
    )


def test_from_try_data_keeps_the_dwd_header_validation_for_a_file(tmp_path):
    weather_file = tmp_path / "not_a_try_file.dat"
    weather_file.write_text("This file has no DWD data header.\n")

    with pytest.raises(TypeError, match="Header row not found"):
        Climate().from_try_data(str(weather_file))


def test_from_try_data_rejects_invalid_region_numbers():
    with pytest.raises(
        ValueError, match="is not a valid number of a DWD TRY region"
    ):
        Climate().from_try_data(16)
