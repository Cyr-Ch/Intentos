"""Hidden invariant test for INV-038: Omitted VDI temperature limits use the documented defaults.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
import pytest
from oemof.demand.vdi import Climate, Region

@pytest.mark.parametrize("house_type", ["EFH", "MFH"])
def test_omitted_vdi_temperature_limits_equal_documented_defaults(house_type):
    base = dict(house_type=house_type, N_Pers=3, N_WE=2,
                Q_Heiz_a=6000, Q_TWW_a=1500, W_a=5250)
    houses = [
        dict(base, name="implicit"),
        dict(base, name="explicit", summer_temperature_limit=15,
             winter_temperature_limit=5),
    ]
    curves = Region(
        2017, Climate().from_try_data(4), houses=houses,
        holidays=[], resample_rule="1h",
    ).get_load_curve_houses()
    pd.testing.assert_frame_equal(curves["implicit"], curves["explicit"])
