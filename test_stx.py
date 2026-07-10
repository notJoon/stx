import pytest

from stx import (
    Fix,
    MatchNode,
    MatchSeq,
    Multi,
    Node,
    Patch,
    Range,
    apply_fixes,
    greedy_survivors,
    overlaps,
)


def leaf(text, start=0, kind="id", field_name=None):
    return Node(kind, start, start + len(text), text=text, field_name=field_name)


def mv(name):
    return Node("metavar", 0, 0, meta=name)


def call(name, args, start=0):
    return Node("call", start, args[-1].end + 1 if args else start + len(name) + 2, text="", children=(leaf(name, start), *args))


def test_lazy_variadic_uses_first_anchor_and_last_variadic_takes_rest():
    src = "a,b,x,c,x,d"
    a = leaf("a", 0)
    b = leaf("b", 2)
    x1 = leaf("x", 4)
    c = leaf("c", 6)
    x2 = leaf("x", 8)
    d = leaf("d", 10)

    B = MatchSeq((mv("$$$A"), leaf("x"), mv("$$$B")), (a, b, x1, c, x2, d), {}, src)

    assert isinstance(B["A"], Multi)
    assert [n.text for n in B["A"].nodes] == ["a", "b"]
    assert source(src, B["A"].span) == "a,b"
    assert [n.text for n in B["B"].nodes] == ["c", "x", "d"]
    assert source(src, B["B"].span) == "c,x,d"


def test_adjacent_variadic_is_compile_error():
    with pytest.raises(ValueError, match="adjacent variadic"):
        MatchSeq((mv("$$$A"), mv("$$$B")), (), {}, "")


def test_repeated_single_metavariable_uses_byte_exact_text():
    p = Node("eq", 0, 0, children=(mv("$X"), mv("$X")))

    good = Node("eq", 0, 10, children=(leaf("a.b", 0), leaf("a.b", 7)))
    bad = Node("eq", 0, 12, children=(leaf("a.b", 0), leaf("a . b", 7)))

    assert MatchNode(p, good, {}, "a.b == a.b") is not None
    assert MatchNode(p, bad, {}, "a.b == a . b") is None


def test_anonymous_metavariable_has_no_equality_constraint():
    p = Node("eq", 0, 0, children=(mv("$_"), mv("$_")))
    t = Node("eq", 0, 6, children=(leaf("a", 0), leaf("b", 5)))

    assert MatchNode(p, t, {}, "a == b") == {}


def test_parenthesized_expression_is_transparent_but_capture_range_is_inner_node():
    p = mv("$A")
    t = Node("parenthesized_expression", 0, 3, children=(leaf("a", 1),), raw_children=(leaf("(", 0, "("), leaf(")", 2, ")")))

    B = MatchNode(p, t, {}, "(a)")

    assert B["A"].span == Range(1, 2)


def test_empty_variadic_span_is_next_anchor_position():
    src = "x"
    x = leaf("x", 0)

    B = MatchSeq((mv("$$$A"), leaf("x")), (x,), {}, src)

    assert B["A"].nodes == ()
    assert B["A"].span == Range(0, 0)


def test_empty_variadic_span_after_previous_node_for_trailing_variadic():
    src = "x"
    x = leaf("x", 0)

    B = MatchSeq((leaf("x"), mv("$$$A")), (x,), {}, src)

    assert B["A"].nodes == ()
    assert B["A"].span == Range(1, 1)


def test_field_name_mismatch_fails_fixed_segment_but_not_variadic_absorption():
    src = "a,b,c"
    a = leaf("a", 0, field_name="left")
    b = leaf("b", 2, field_name="middle")
    c = leaf("c", 4, field_name="right")

    assert MatchSeq((leaf("a", field_name="right"),), (a,), {}, src) is None

    B = MatchSeq((mv("$$$A"), leaf("c", field_name="right")), (a, b, c), {}, src)

    assert [n.field_name for n in B["A"].nodes] == ["left", "middle"]


def test_half_open_overlap_and_same_point_insertions_overlap():
    assert overlaps(Range(0, 1), Range(1, 2)) is False
    assert overlaps(Range(1, 1), Range(1, 1)) is True


def test_apply_fixes_sorts_accepts_non_overlapping_and_splices_back_to_front():
    src = "abcdef"
    f2 = Fix("b", (Patch(Range(4, 6), "EF"),))
    f1 = Fix("a", (Patch(Range(0, 2), "AB"),))

    out = apply_fixes(src, (f2, f1))

    assert out.src == "ABcdEF"
    assert [f.rule_id for f in out.fixes] == ["a", "b"]


def test_apply_fixes_discards_whole_fix_when_any_patch_overlaps_accepted_range():
    src = "abcdef"
    f1 = Fix("a", (Patch(Range(0, 2), "AB"),))
    f2 = Fix("b", (Patch(Range(1, 3), "XX"), Patch(Range(4, 5), "Y")))

    out = apply_fixes(src, (f1, f2))

    assert out.src == "ABcdef"
    assert [f.rule_id for f in out.fixes] == ["a"]


def test_greedy_survivors_keeps_deterministic_prefix_that_does_not_increase_parse_errors():
    src = "abcd"
    good = Fix("a", (Patch(Range(0, 1), "A"),))
    bad = Fix("b", (Patch(Range(1, 2), "!"),))
    also_good = Fix("c", (Patch(Range(2, 3), "C"),))

    survivors = greedy_survivors(src, (good, bad, also_good), 0, lambda s: s.count("!"))

    assert [f.rule_id for f in survivors] == ["a", "c"]


def source(src, span):
    return src[span.start:span.end]
