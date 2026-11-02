"""Display-name rules: ordinary names pass, profanity is caught even when disguised."""

from __future__ import annotations

import pytest

from arc_api.names import BadNameError, clean

ORDINARY = [
    "Pawan",
    "Pawan Kumar",
    "Glasshopper",
    "Class Act",
    "Assam Tiger",
    "Bassist",
    "Sexton",
    "Ananya",
    "Mehul.C",
    "O'Brien",
    "Raj-01",
    "player_7",
    "Shiv Kumar",
    "Pranav Rao",
    # Real names containing a blocked word: must pass.
    "Gandhi",
    "Wankhede",
    "Shital",
    "Nazia",
    "Nazir",
    "Lundgren",
    "Hancock",
    "Dickens",
    "Salazar",
    "Draper",
    "Chodankar",
    "Analise",
    "Nigeria Fan",
    "Randhir",
]

PROFANE = [
    "fuck",
    "F u c k",
    "fuuuuck you",
    "f.u.c.k",
    "Sh1t",
    "B!tch",
    "a55",
    "ass",
    "Big Ass",
    "Chut1ya",
    "madar chod",
    "BC",
    "bsdk",
    "MC Raj",
    "l0da",
    "xXfuckerXx",
    "dickhead99",
    "shit",
    "wank",
    "bullshit",
    "gandu",
]


@pytest.mark.parametrize("name", ORDINARY)
def test_ordinary_names_pass(name: str) -> None:
    assert clean(name) == name


@pytest.mark.parametrize("name", PROFANE)
def test_profanity_is_refused(name: str) -> None:
    with pytest.raises(BadNameError):
        clean(name)


def test_names_are_tidied_and_bounded() -> None:
    assert clean("  Pawan   Kumar ") == "Pawan Kumar"
    for bad in ["a", "x" * 21, "<script>", "   ", "--", "hi?"]:
        with pytest.raises(BadNameError):
            clean(bad)
