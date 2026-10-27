"""Hidden invariant test for INV-022: BDEW 2025 excerpts retain calendar-based values.

Written by the coding agent (intentos-policy-mining skill), run and passing at the base revision by intentos review. Hidden tests run from the verification snapshot and must check behaviour
through interfaces the task description implies, never names only one change introduces.
"""
import datetime
import pandas as pd
import pytest
from oemof.demand import bdew

@pytest.mark.parametrize("profile_type", [bdew.G25, bdew.H25, bdew.L25, bdew.P25, bdew.S25])
def test_bdew25_excerpts_retain_calendar_values(profile_type):
    index = pd.date_range("2010-01-01", periods=8760*4, freq="15min")
    holidays = {datetime.date(2010, 1, 1): "New year"}
    full = profile_type(index, holidays=holidays)
    for section in [slice(5, 1000), slice(14000, 16000), slice(-1000, None)]:
        short = profile_type(index[section], holidays=holidays)
        assert short.equals(full.iloc[section])
