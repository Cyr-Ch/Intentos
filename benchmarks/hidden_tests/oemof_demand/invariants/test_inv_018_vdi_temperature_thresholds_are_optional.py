"""Hidden invariant test for INV-018: VDI temperature thresholds are optional.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pandas as pd
from oemof.demand.vdi import Climate, Region

def test_vdi_omitted_temperature_thresholds_use_defaults():
    house = dict(name="single", house_type="EFH", N_Pers=3, N_WE=1,
                 Q_Heiz_a=6000, Q_TWW_a=1500, W_a=5250)
    explicit = dict(house, summer_temperature_limit=15, winter_temperature_limit=5)
    implicit_curve = Region(2017, Climate().from_try_data(4), houses=[house],
                            holidays=[], resample_rule="1h").get_load_curve_houses()
    explicit_curve = Region(2017, Climate().from_try_data(4), houses=[explicit],
                            holidays=[], resample_rule="1h").get_load_curve_houses()
    pd.testing.assert_frame_equal(implicit_curve, explicit_curve)
