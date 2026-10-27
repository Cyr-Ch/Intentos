"""Hidden invariant test for INV-019: VDI timestamps label interval starts.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand.vdi import Climate, Region

@pytest.mark.parametrize("resolution, steps", [("1h", 8760), ("15min", 35040)])
def test_vdi_timestamps_label_interval_starts(resolution, steps):
    house = dict(name="single", house_type="EFH", N_Pers=3, N_WE=1,
                 Q_Heiz_a=6000, Q_TWW_a=1500, W_a=5250)
    curves = Region(2017, Climate().from_try_data(4), houses=[house],
                    holidays=[], resample_rule=resolution).get_load_curve_houses()
    expected = pd.date_range("2017-01-01", periods=steps, freq=resolution)
    pd.testing.assert_index_equal(curves.index, expected)
