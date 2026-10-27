"""Hidden invariant test for INV-015: VDI demand matches each house and energy carrier.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import pytest
from oemof.demand.vdi import Climate, Region

@pytest.mark.parametrize("resolution", ["1h", "15min"])
def test_vdi_conserves_each_house_and_energy_carrier(resolution):
    houses = [
        dict(name="single", house_type="EFH", N_Pers=3, N_WE=1, Q_Heiz_a=6000, Q_TWW_a=1500, W_a=5250),
        dict(name="multi", house_type="MFH", N_Pers=45, N_WE=15, Q_Heiz_a=60000, Q_TWW_a=15000, W_a=45000)]
    curves = Region(2017, Climate().from_try_data(4), houses=houses,
                    holidays=[], resample_rule=resolution).get_load_curve_houses()
    assert curves.notna().all().all()
    for house in houses:
        for energy, annual in [("Q_Heiz_TT", "Q_Heiz_a"), ("Q_TWW_TT", "Q_TWW_a"), ("W_TT", "W_a")]:
            assert curves[house["name"], house["house_type"], energy].sum() == pytest.approx(house[annual], rel=1e-10)
