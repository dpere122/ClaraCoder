"""Minimal dependency-free HTML tree used by the built-in metasearch parsers.

The search engines we scrape return markup we only need to walk by tag and class,
so a full DOM library would be a heavy dependency for a handful of selectors.
``html.parser`` already ships with CPython; this module turns its event stream into
a small tree with just enough query surface (``find_all`` / ``find_first`` / ``text_of``).
"""

from __future__ import annotations

from html.parser import HTMLParser

__all__ = ['Node', 'find_all', 'find_first', 'parse_html', 'text_of']

_VOID_TAGS = frozenset(
    {
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
    }
)

_SKIP_TEXT_TAGS = frozenset({'script', 'style', 'noscript'})

_TEXT_TAG = '#text'
_ROOT_TAG = '#document'


class Node:
    """One element (or text run) in a parsed HTML tree."""

    __slots__ = ('attrs', 'children', 'data', 'parent', 'tag')

    def __init__(
        self,
        tag: str,
        attrs: dict[str, str] | None = None,
        parent: 'Node | None' = None,
        data: str = '',
    ) -> None:
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list['Node'] = []
        self.parent = parent
        self.data = data

    def get(self, name: str, default: str = '') -> str:
        return self.attrs.get(name, default)

    def classes(self) -> frozenset[str]:
        return frozenset((self.attrs.get('class') or '').split())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f'<Node {self.tag} {sorted(self.attrs)}>'


def _matches(node: Node, tag: str | None, class_: str | None) -> bool:
    if tag is not None and node.tag != tag:
        return False
    if class_ is not None and class_ not in node.classes():
        return False
    return True


def find_all(
    node: Node,
    *,
    tag: str | None = None,
    class_: str | None = None,
    limit: int | None = None,
) -> list[Node]:
    """Depth-first descendants of ``node`` matching ``tag`` and/or ``class_`` (excludes ``node``)."""

    found: list[Node] = []
    stack: list[Node] = [node]
    while stack:
        current = stack.pop()
        if current is not node and _matches(current, tag, class_):
            found.append(current)
            if limit is not None and len(found) >= limit:
                break
        stack.extend(reversed(current.children))
    return found


def find_first(node: Node, *, tag: str | None = None, class_: str | None = None) -> Node | None:
    hits = find_all(node, tag=tag, class_=class_, limit=1)
    return hits[0] if hits else None


def text_of(node: Node) -> str:
    """Whitespace-collapsed text of ``node``, skipping script/style/noscript bodies."""

    chunks: list[str] = []
    stack: list[Node] = [node]
    while stack:
        current = stack.pop()
        if current.tag == _TEXT_TAG:
            chunks.append(current.data)
            continue
        if current.tag in _SKIP_TEXT_TAGS:
            continue
        stack.extend(reversed(current.children))
    return ' '.join(''.join(chunks).split())


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node(_ROOT_TAG)
        self._stack: list[Node] = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {name: value or '' for name, value in attrs}, self._stack[-1])
        self._stack[-1].children.append(node)
        if tag not in _VOID_TAGS:
            self._stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {name: value or '' for name, value in attrs}, self._stack[-1])
        self._stack[-1].children.append(node)

    def handle_endtag(self, tag: str) -> None:
        # Pop to the nearest matching open element; stray end tags are ignored.
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == tag:
                del self._stack[index:]
                return

    def handle_data(self, data: str) -> None:
        if data:
            self._stack[-1].children.append(Node(_TEXT_TAG, parent=self._stack[-1], data=data))


def parse_html(markup: str) -> Node:
    """Parse ``markup`` into a tree rooted at a synthetic ``#document`` node."""

    builder = _TreeBuilder()
    try:
        builder.feed(markup or '')
        builder.close()
    except Exception:
        # Malformed markup: keep whatever was built before the parser gave up.
        pass
    return builder.root
