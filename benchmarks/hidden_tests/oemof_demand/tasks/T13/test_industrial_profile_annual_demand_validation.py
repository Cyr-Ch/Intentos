"""Acceptance tests for T13, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d29-8ee0-7291-9dad-12fae4db73bf).

Base revision 6757f4f659, 2026-10-27T11:41:22.149Z. At that revision: test_simple_profile_warns_for_zero_annual_demand failed, test_simple_profile_rejects_negative_annual_demand failed, test_simple_profile_positive_annual_demand_is_unchanged passed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- simple_profile emits a UserWarning and returns the zero-valued profile for zero annual demand.
- simple_profile raises ValueError for negative annual demand.
- simple_profile retains its existing positive-demand normalization and weekday day/night shape without a UserWarning.

Ticket:
    Warn when an industrial profile is created with zero or negative annual demand
    
    A unit mix-up gave us `annual_demand=0` and the industrial profile came back all zeros without a word; a
    negative value produces a negative profile just as quietly.
    
    In the spirit of the recent holidays warning, please emit a UserWarning for zero demand and raise a ValueError
    for negative demand in `simple_profile`. Positive demand must behave exactly as before.
"""
import warnings

import numpy as np
import pandas as pd
import pytest

from oemof.demand.particular_profiles import IndustrialLoadProfile


def make_profile():
    dt_index = pd.date_range("2010-01-01", periods=24 * 7, freq="1h")
    return IndustrialLoadProfile(dt_index=dt_index)


def test_simple_profile_warns_for_zero_annual_demand():
    profile = make_profile()

    with pytest.warns(UserWarning):
        result = profile.simple_profile(annual_demand=0)

    assert (result == 0).all()


def test_simple_profile_rejects_negative_annual_demand():
    profile = make_profile()

    with pytest.raises(ValueError):
        profile.simple_profile(annual_demand=-1.0)


def test_simple_profile_positive_annual_demand_is_unchanged():
    profile = make_profile()

    with warnings.catch_warnings():
        warnings.simplefilter("error", UserWarning)
        result = profile.simple_profile(annual_demand=1.0)

    assert result.index.equals(profile.dataframe.index)
    assert np.isclose(result.sum(), 1.0)
    assert result.iloc[7] / result.iloc[6] == pytest.approx(0.8 / 0.6)
