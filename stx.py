from dataclasses import dataclass


@dataclass(frozen=True)
class Range:
    start: int
    end: int


@dataclass(frozen=True)
class Node:
    kind: str
    start: int
    end: int
    text: str = ""
    children: tuple = ()
    field_name: str | None = None
    meta: str | None = None
    raw_children: tuple = ()


@dataclass(frozen=True)
class Single:
    node: Node

    @property
    def span(self):
        return Range(self.node.start, self.node.end)


@dataclass(frozen=True)
class Multi:
    nodes: tuple
    span: Range


@dataclass(frozen=True)
class Patch:
    range: Range
    text: str


@dataclass(frozen=True)
class Fix:
    rule_id: str
    patches: tuple


@dataclass(frozen=True)
class Applied:
    src: str
    fixes: tuple


def source_text(src, x):
    if isinstance(x, Range):
        return src[x.start:x.end]
    if isinstance(x, Node):
        return src[x.start:x.end] if x.text == "" else x.text
    return src[x.span.start:x.span.end]


def units(node):
    return tuple(c for c in node.children if c.kind != ",")


def unwrap(node):
    return units(node)[0]


def is_single_meta(node):
    return node.meta is not None and node.meta.startswith("$") and not node.meta.startswith("$$$")


def is_variadic(node):
    return node.meta is not None and node.meta.startswith("$$$")


def visible_name(node):
    return node.meta.lstrip("$")


def bind(name, value, B, src):
    if name == "_":
        return B
    if name in B and source_text(src, B[name]) != source_text(src, value):
        return None
    C = dict(B)
    C[name] = value
    return C


def MatchNode(p, t, B, src, transparent_nodes=("parenthesized_expression",)):
    if p.kind in transparent_nodes:
        return MatchNode(unwrap(p), t, B, src, transparent_nodes)
    if t.kind in transparent_nodes:
        return MatchNode(p, unwrap(t), B, src, transparent_nodes)
    if p.meta == "$_":
        return B
    if is_single_meta(p):
        return bind(visible_name(p), Single(t), B, src)
    if p.kind != t.kind:
        return None
    if len(units(p)) == 0:
        return B if source_text(src, p) == source_text(src, t) else None
    return MatchSeq(units(p), units(t), B, src)


def split_segments(ps):
    F0 = []
    rest = []
    current = F0
    V = None
    for p in ps:
        if is_variadic(p):
            V = p
            current = []
            rest.append([V, current])
        else:
            current.append(p)
    return tuple(F0), tuple((V, tuple(F)) for V, F in rest)


def reject_adjacent_variadics(ps):
    for a, b in zip(ps, ps[1:]):
        if is_variadic(a) and is_variadic(b):
            raise ValueError("adjacent variadic")


def field_matches(p, t):
    return p.field_name == t.field_name


def MatchSeq(ps, ts, B, src, parent=None):
    reject_adjacent_variadics(ps)
    F0, pairs = split_segments(ps)
    i = 0

    for p in F0:
        if i >= len(ts) or not field_matches(p, ts[i]):
            return None
        B = MatchNode(p, ts[i], B, src)
        if B is None:
            return None
        i += 1

    for Vj, Fj in pairs:
        if len(Fj) == 0:
            B = bind_variadic(Vj, ts, i, len(ts), B, src, parent)
            if B is None:
                return None
            i = len(ts)
        else:
            s = i
            while True:
                if AnchorMatches(Fj, ts, s, B, src):
                    break
                s += 1
                if s + len(Fj) > len(ts):
                    return None
            B = bind_variadic(Vj, ts, i, s, B, src, parent)
            if B is None:
                return None
            for p in Fj:
                if not field_matches(p, ts[s]):
                    return None
                B = MatchNode(p, ts[s], B, src)
                if B is None:
                    return None
                s += 1
            i = s

    return B if i == len(ts) else None


def AnchorMatches(F, ts, s, B, src):
    if len(F) > len(ts) - s:
        return False
    C = dict(B)
    for m, p in enumerate(F):
        if not field_matches(p, ts[s + m]):
            return False
        C = MatchNode(p, ts[s + m], C, src)
        if C is None:
            return False
    return True


def bind_variadic(V, ts, i, s, B, src, parent=None):
    if V.meta == "$$$_":
        return B
    nodes = ts[i:s]
    span = Range(nodes[0].start, nodes[-1].end) if nodes else empty_span(ts, i, s, parent)
    return bind(visible_name(V), Multi(tuple(nodes), span), B, src)


def empty_span(ts, i, s, parent=None):
    if s < len(ts):
        return Range(ts[s].start, ts[s].start)
    if i > 0:
        return Range(ts[i - 1].end, ts[i - 1].end)
    if parent is not None and parent.raw_children:
        d = parent.raw_children[0]
        return Range(d.end, d.end)
    if parent is not None:
        return Range(parent.start, parent.start)
    return Range(0, 0)


def overlaps(a, b):
    if a.start == a.end and b.start == b.end:
        return a.start == b.start
    return a.start < b.end and b.start < a.end


def apply_fixes(src, fixes):
    accepted = []
    ranges = []
    for f in sorted(fixes, key=lambda f: (
        min(p.range.start for p in f.patches),
        min(p.range.end for p in f.patches),
        f.rule_id,
    )):
        self_ranges = [p.range for p in f.patches]
        if any(overlaps(a, b) for n, a in enumerate(self_ranges) for b in self_ranges[n + 1:]):
            continue
        if all(not overlaps(p.range, r) for p in f.patches for r in ranges):
            accepted.append(f)
            ranges.extend(p.range for p in f.patches)

    for p in sorted((p for f in accepted for p in f.patches), key=lambda p: p.range.start, reverse=True):
        src = src[:p.range.start] + p.text + src[p.range.end:]
    return Applied(src, tuple(accepted))


def greedy_survivors(src, applied, baseline, parse_count):
    survivors = []
    for f in applied:
        candidate = survivors + [f]
        new_src = splice(src, candidate)
        if parse_count(new_src) <= baseline:
            survivors.append(f)
    return tuple(survivors)


def splice(src, fixes):
    for p in sorted((p for f in fixes for p in f.patches), key=lambda p: p.range.start, reverse=True):
        src = src[:p.range.start] + p.text + src[p.range.end:]
    return src
