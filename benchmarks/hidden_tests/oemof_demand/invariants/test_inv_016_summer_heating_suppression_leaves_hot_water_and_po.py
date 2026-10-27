"""Hidden invariant test for INV-016: Summer heating suppression leaves hot water and power available.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
from oemof.demand.vdi import Climate, Region

def test_vdi_summer_suppression_only_removes_space_heating():
    houses = [
        dict(name="single", house_type="EFH", N_Pers=3, N_WE=1, Q_Heiz_a=6000, Q_TWW_a=1500, W_a=5250),
        dict(name="multi", house_type="MFH", N_Pers=45, N_WE=15, Q_Heiz_a=60000, Q_TWW_a=15000, W_a=45000)]
    seasons = {"summer1": [5,15,9,14], "transition1": [3,21,5,14],
               "transition2": [9,15,10,31], "winter1": [1,1,3,20], "winter2": [11,1,12,31]}
    curves = Region(2017, Climate().from_try_data(4), houses=houses,
                    holidays=[], seasons=seasons, resample_rule="1h",
                    zero_summer_heat_demand=True).get_load_curve_houses()
    summer = curves.loc["2017-05-15":"2017-09-14"]
    assert len(summer) == 123 * 24
    for house in houses:
        key = (house["name"], house["house_type"])
        assert (summer[key + ("Q_Heiz_TT",)] == 0).all()
        assert summer[key + ("Q_TWW_TT",)].sum() > 0
        assert summer[key + ("W_TT",)].sum() > 0
