"""Acceptance tests for T09, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d25-d1c3-7b22-b388-cf98f90c9b07).

Base revision 6757f4f659, 2026-10-27T11:37:43.799Z. At that revision: test_constructor_rejects_unknown_shlp_type_with_accepted_types failed, test_constructor_rejects_unknown_wind_class_with_accepted_values failed, test_constructor_rejects_residential_building_class_outside_range failed, test_constructor_keeps_non_residential_building_class_rule failed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Rejects an unknown shlp_type during HeatBuilding construction and lists all accepted profile types.
- Rejects wind_class values other than 0 and 1 during HeatBuilding construction.
- Rejects residential building_class values outside 1 through 11 during HeatBuilding construction.
- Preserves the rule that a non-residential profile must use building_class 0.

Ticket:
    Validate HeatBuilding inputs when the object is created
    
    A typo in `shlp_type` (say "EFG") or a `wind_class` of 2 only blows up much later inside the sigmoid/weekday
    parameter lookups with a KeyError or an empty-selection message that does not name the parameter.
    
    Please check `shlp_type`, `wind_class` and `building_class` when `HeatBuilding` is constructed and raise a
    ValueError that names the offending parameter and the accepted values. The existing rule that non-residential
    types must use building class 0 must stay.
"""
import pandas as pd
import pytest

from oemof.demand.bdew.heat_building import HeatBuilding


VALID_SHLP_TYPES = (
    "EFH",
    "MFH",
    "GMK",
    "GHA",
    "GKO",
    "GBD",
    "GGA",
    "GBH",
    "GWA",
    "GGB",
    "GBA",
    "GPD",
    "GMF",
    "GHD",
)


def make_heat_building(**kwargs):
    index = pd.date_range("2010-01-01", periods=24, freq="h")
    parameters = {
        "df_index": index,
        "temperature": pd.Series([15] * len(index)),
        "annual_heat_demand": 10000,
        "shlp_type": "EFH",
        "wind_class": 0,
        "building_class": 1,
    }
    parameters.update(kwargs)
    return HeatBuilding(**parameters)


def test_constructor_rejects_unknown_shlp_type_with_accepted_types():
    with pytest.raises(ValueError) as error:
        make_heat_building(shlp_type="EFG", building_class=0)

    message = str(error.value)
    assert "shlp_type" in message
    for shlp_type in VALID_SHLP_TYPES:
        assert shlp_type in message


def test_constructor_rejects_unknown_wind_class_with_accepted_values():
    with pytest.raises(ValueError) as error:
        make_heat_building(wind_class=2)

    message = str(error.value)
    assert "wind_class" in message
    assert "0" in message
    assert "1" in message


def test_constructor_rejects_residential_building_class_outside_range():
    with pytest.raises(ValueError) as error:
        make_heat_building(building_class=12)

    message = str(error.value)
    assert "building_class" in message
    assert "1" in message
    assert "11" in message


def test_constructor_keeps_non_residential_building_class_rule():
    with pytest.raises(ValueError) as error:
        make_heat_building(shlp_type="GHD", building_class=1)

    message = str(error.value)
    assert "building_class" in message
    assert "0" in message
