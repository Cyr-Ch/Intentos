"""Hidden invariant test for INV-010: BDEW 2025 profiles retain their annual energy baseline.

Lifted from tests/test_elec_slp.py::test_slp25 by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import pandas as pd
import pytest
from oemof.demand import bdew

def test_slp25():
    holiday_dict = {
        datetime.date(2010, 1, 1): "New year",
        datetime.date(2010, 4, 2): "Good Friday",
        datetime.date(2010, 4, 5): "Easter Monday",
        datetime.date(2010, 5, 1): "Labour Day",
        datetime.date(2010, 5, 13): "Ascension Thursday",
        datetime.date(2010, 5, 24): "Whit Monday",
        datetime.date(2010, 10, 3): "Day of German Unity",
        datetime.date(2010, 12, 25): "Christmas Day",
        datetime.date(2010, 12, 26): "Second Christmas Day",
    }

    holiday_list = list(holiday_dict.keys())

    index01m = pd.date_range(  # 1 minute time steps
        start="2010-01-01 00:00",
        end="2010-12-31 23:45",
        freq="1min",
    )

    index15m = pd.date_range(  # 15 minute time steps
        start="2010-01-01 00:00",
        end="2010-12-31 23:45",
        freq="15min",
    )

    index60m = pd.date_range(  # 60 minute time steps
        start="2010-01-01 00:00",
        end="2010-12-31 23:45",
        freq="60min",
    )

    index_2years = pd.date_range(  # 2010 and 2011
        start="2010-01-01 00:00",
        end="2011-12-31 23:45",
        freq="15min",
    )

    index_shifted_year = pd.date_range(  # 12 month starting June 2010
        start="2010-06-01 00:00",
        end="2011-05-31 23:45",
        freq="15min",
    )

    with pytest.raises(NotImplementedError):
        _ = bdew._profiles25.BDEW25Profile(index15m)

    with pytest.raises(NotImplementedError):
        _ = bdew._profiles25.DynamicBDEW25Profile(index15m)

    for slp_type in [bdew.G25, bdew.H25, bdew.L25, bdew.P25, bdew.S25]:
        # We allow 1.0 % tollerenace (with holidays)
        slp_profile = slp_type(index15m, holidays=holiday_dict)
        assert slp_profile.sum() / 4 == pytest.approx(1e6, rel=0.01)

        # SLP of a shorter index is just the excerpt of the original SLP
        short_slp = slp_type(index15m[5:1000], holidays=holiday_dict)
        assert short_slp.equals(slp_profile[5:1000])

        # Higher resolution samples the same SLP, the integral is unchanged
        slp_resampled = slp_type(index01m, holidays=holiday_list)
        assert slp_resampled.sum() / 15 == pytest.approx(
            slp_profile.sum(), rel=0.0001
        )

        # Lower time resolution averages, so integral is unchanged
        slp_resampled = slp_type(index60m, holidays=holiday_dict)
        assert slp_resampled.sum() * 4 == pytest.approx(
            slp_profile.sum(), rel=0.0001
        )

        # We allow 2.5 % tollerenace (without holidays)
        slp_profile = slp_type(index15m)
        assert slp_profile.sum() / 4 == pytest.approx(1e6, rel=0.025)

        # We allow 2.5 % tollerenace (without holidays)
        slp_profile = slp_type(index_shifted_year)
        assert slp_profile.sum() / 4 == pytest.approx(1e6, rel=0.025)

        # We allow 2.5 % tollerenace (without holidays), two years
        slp_profile = slp_type(index_2years)
        assert slp_profile.sum() / 4 == pytest.approx(2e6, rel=0.025)
