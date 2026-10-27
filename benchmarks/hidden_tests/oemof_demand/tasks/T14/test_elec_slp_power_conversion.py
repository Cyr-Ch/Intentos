"""Acceptance tests for T14, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d2a-3c37-78e0-9832-99e5329fc529).

Base revision 6757f4f659, 2026-10-27T11:41:43.602Z. At that revision: test_scaled_power_profiles_derives_conversion_factor_from_index_resolution[1h-sum-1] failed, test_scaled_power_profiles_derives_conversion_factor_from_index_resolution[1min-asfreq-60] failed, test_scaled_power_profiles_explicit_conversion_factor_overrides_resolution passed, test_scaled_power_profiles_keeps_quarter_hour_default_factor passed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Derives factor 1 for hourly profiles when no conversion factor is supplied.
- Derives factor 60 for one-minute profiles when no conversion factor is supplied.
- Keeps an explicitly supplied conversion factor as an override.
- Preserves the default factor of 4 for quarter-hourly profiles.

Ticket:
    Derive the power conversion factor from the index resolution in ElecSlp
    
    `get_scaled_power_profiles` multiplies by a conversion factor that defaults to 4, which is only right for
    quarter-hour data. When I resample to hourly first and forget the argument, the power is four times too high.
    
    Please derive the factor from the profile's index frequency when it is not given explicitly (1 h → 1,
    15 min → 4, 1 min → 60). Passing the factor explicitly must keep overriding it, and the quarter-hourly default
    behaviour must not change.
"""
import pandas as pd
import pytest

from oemof.demand import bdew


def _resampled_slp(rule, aggregation):
    slp = bdew.ElecSlp(2010)
    slp.slp_frame = getattr(slp.slp_frame.resample(rule), aggregation)()
    return slp


@pytest.mark.parametrize(
    ("rule", "aggregation", "expected_factor"),
    [
        ("1h", "sum", 1),
        ("1min", "asfreq", 60),
    ],
)
def test_scaled_power_profiles_derives_conversion_factor_from_index_resolution(
    rule, aggregation, expected_factor
):
    slp = _resampled_slp(rule, aggregation)
    annual_demand = 3000

    # A minute-resolution profile represents the same quarter-hour energy
    # profile with gaps between its original samples. Fill those gaps before
    # distributing each quarter-hour value over its 15 one-minute intervals.
    if rule == "1min":
        slp.slp_frame = slp.slp_frame.ffill().div(15)

    power = slp.get_scaled_power_profiles({"h0": annual_demand})

    assert power["h0"].sum() == pytest.approx(
        annual_demand * expected_factor
    )


def test_scaled_power_profiles_explicit_conversion_factor_overrides_resolution():
    slp = _resampled_slp("1h", "sum")

    power = slp.get_scaled_power_profiles({"h0": 3000}, conversion_factor=4)

    assert power["h0"].sum() == pytest.approx(12000)


def test_scaled_power_profiles_keeps_quarter_hour_default_factor():
    slp = bdew.ElecSlp(2010)

    power = slp.get_scaled_power_profiles({"h0": 3000})

    assert power["h0"].sum() == pytest.approx(12000)
