"""Hidden invariant test for INV-032: VDI profiles conserve every house's annual energy demands.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pytest
from oemof.demand.vdi import Climate, Region

@pytest.mark.parametrize("resolution", ["15min", "1h"])
def test_vdi_preserves_each_house_and_energy_annual_demand(resolution):
    houses = [
        dict(name="single", house_type="EFH", N_Pers=3, N_WE=1,
             Q_Heiz_a=6000, Q_TWW_a=1500, W_a=5250,
             summer_temperature_limit=15, winter_temperature_limit=5),
        dict(name="multi", house_type="MFH", N_Pers=45, N_WE=15,
             Q_Heiz_a=60000, Q_TWW_a=15000, W_a=45000,
             summer_temperature_limit=15, winter_temperature_limit=5),
    ]
    curves = Region(
        2017, Climate().from_try_data(4), houses=houses,
        holidays=[], resample_rule=resolution,
    ).get_load_curve_houses()
    for house in houses:
        for output, annual in [("Q_Heiz_TT", "Q_Heiz_a"),
                               ("Q_TWW_TT", "Q_TWW_a"), ("W_TT", "W_a")]:
            profile = curves[(house["name"], house["house_type"], output)]
            assert profile.notna().all()
            assert profile.sum() == pytest.approx(house[annual], rel=1e-10, abs=1e-8)
