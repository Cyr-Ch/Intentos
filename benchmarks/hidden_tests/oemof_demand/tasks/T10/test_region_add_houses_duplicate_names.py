"""Acceptance tests for T10, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d26-e701-7312-b098-24788482f0a6).

Base revision 6757f4f659, 2026-10-27T11:38:05.639Z. At that revision: test_add_houses_rejects_a_name_repeated_in_one_call failed, test_add_houses_rejects_a_name_already_in_the_region failed.
Expectation: the requested behaviour does not exist yet; at least one test fails now and all pass once implemented.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- Region.add_houses raises ValueError and identifies a name repeated within one supplied house list.
- Region.add_houses raises ValueError and identifies a name that is already present in the region.

Ticket:
    Region.add_houses should reject duplicate house names
    
    The VDI 4655 `Region.add_houses` docs say the house name is a unique identifier, but adding two houses with the
    same name is accepted and one of them silently disappears from the results, which took me a while to notice.
    
    Please raise a ValueError naming the duplicate when a house list contains a repeated name, or when a name is
    already present in the region.
"""
import pytest

from oemof.demand.vdi import Climate
from oemof.demand.vdi.regions import Region


def _house(name):
    return {"name": name, "house_type": "EFH"}


def _region():
    return Region(2017, Climate().from_try_data(4))


def test_add_houses_rejects_a_name_repeated_in_one_call():
    duplicate_name = "duplicate-house"

    with pytest.raises(ValueError) as error:
        _region().add_houses([_house(duplicate_name), _house(duplicate_name)])

    assert duplicate_name in str(error.value)


def test_add_houses_rejects_a_name_already_in_the_region():
    duplicate_name = "existing-house"
    region = _region()
    region.add_houses([_house(duplicate_name)])

    with pytest.raises(ValueError) as error:
        region.add_houses([_house(duplicate_name)])

    assert duplicate_name in str(error.value)
