"""Acceptance tests for T06, written before implementation by gpt-5.6-terra (IntentOS acceptance, thread 01a17d23-6705-7712-a6af-86b1dc151e20).

Base revision 6757f4f659, 2026-10-27T11:34:55.166Z. At that revision: test_elec_slp_2024_does_not_emit_future_warning passed.
Expectation: the behaviour already exists; all tests pass now.
Hidden from the implementer. Assert behaviour through public entry points so that any compliant implementation passes.

Covers:
- ElecSlp(2024) constructs successfully when FutureWarning is escalated to an error.
- The leap-year load-profile frame remains available after construction.

Ticket:
    FutureWarning on ElecSlp instantiation with pandas 2.2
    
    Creating `ElecSlp(2024)` with pandas 2.2 prints a FutureWarning about an incompatible dtype assignment and, in
    environments that escalate warnings to errors, the constructor fails. Please fix the dtype handling.
"""
import warnings

from oemof.demand import bdew


def test_elec_slp_2024_does_not_emit_future_warning():
    with warnings.catch_warnings():
        warnings.simplefilter("error", FutureWarning)
        slp = bdew.ElecSlp(2024)

    assert len(slp.slp_frame) == 8784 * 4
