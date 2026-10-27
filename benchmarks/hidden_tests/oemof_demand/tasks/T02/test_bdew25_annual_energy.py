"""Acceptance tests for T02, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d21-7926-7a20-9e54-c56506298ed1).

Base revision 6757f4f659, 2026-10-27T11:32:26.347Z. At that revision: test_bdew25_profiles_scale_to_requested_annual_energy[G25] failed, test_bdew25_profiles_scale_to_requested_annual_energy[H25] failed, test_bdew25_profiles_scale_to_requested_annual_energy[L25] failed, test_bdew25_profiles_scale_to_requested_annual_energy[P25] failed, test_bdew25_profiles_scale_to_requested_annual_energy[S25] failed, test_bdew25_annual_energy_scaling_uses_the_index_step_size[1min] failed, test_bdew25_annual_energy_scaling_uses_the_index_step_size[60min] failed, test_bdew25_profile_without_annual_energy_is_unchanged passed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- All public 2025 BDEW profile classes accept a requested annual energy in kWh and integrate to it on a quarter-hourly index.
- Annual-energy scaling integrates correctly for both higher- and lower-resolution constant-step indexes.
- Constructing a 2025 profile without annual energy retains its existing approximately 1 GWh annual normalization.

Ticket:
    Scale a BDEW 2025 profile to a given annual energy
    
    The new `G25`/`H25`/... profiles come normalised to 1 GWh per year in kW. Every user has to do the scaling by hand
    and it is easy to get the factor wrong for non-quarter-hourly indexes.
    
    Please add a way to get a 2025 profile scaled so that it integrates to an annual energy I specify (in kWh),
    for any constant-step index the class already accepts. The unscaled behaviour must stay exactly as it is.
"""
import pandas as pd
import pytest

from oemof.demand import bdew


def _energy_in_kwh(profile):
    step_hours = pd.Timedelta(profile.index.freq).total_seconds() / 3600
    return profile.sum() * step_hours


@pytest.mark.parametrize(
    "profile_type",
    [bdew.G25, bdew.H25, bdew.L25, bdew.P25, bdew.S25],
)
def test_bdew25_profiles_scale_to_requested_annual_energy(profile_type):
    index = pd.date_range(
        "2010-01-01 00:00", "2010-12-31 23:45", freq="15min"
    )

    profile = profile_type(index, annual_energy=3_456.7)

    assert _energy_in_kwh(profile) == pytest.approx(3_456.7, rel=1e-10)


@pytest.mark.parametrize("frequency", ["1min", "60min"])
def test_bdew25_annual_energy_scaling_uses_the_index_step_size(frequency):
    index = pd.date_range(
        "2010-01-01 00:00", "2010-12-31 23:45", freq=frequency
    )

    profile = bdew.G25(index, annual_energy=12_345)

    assert _energy_in_kwh(profile) == pytest.approx(12_345, rel=1e-10)


def test_bdew25_profile_without_annual_energy_is_unchanged():
    index = pd.date_range(
        "2010-01-01 00:00", "2010-12-31 23:45", freq="60min"
    )

    profile = bdew.H25(index)

    assert _energy_in_kwh(profile) == pytest.approx(1_000_000, rel=0.025)
