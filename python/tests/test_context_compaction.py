"""Context compaction's pure logic: sizes, budgets, the cut, the rendered view, the digest, tool budgets."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import openai
import pytest
from langchain_anthropic import ChatAnthropic
from langchain_core.exceptions import ContextOverflowError
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from clara_coder_backend.domain import RuntimeContextCompressionConfig
from clara_coder_backend.lang_agent.context_compaction import (
    BLOCK_HEADER,
    CHARS_PER_TOKEN,
    IMAGE_REMOVED_TEXT,
    PIN_LEAD,
    SUMMARY_REQUEST,
    accepted_notes,
    block_text,
    bounded_step_settings,
    build_digest,
    choose_cut,
    choose_elisions,
    compaction_due,
    compute_budget,
    continuation_request,
    corrected_ratio,
    digest_cap_chars,
    elided_message,
    elided_tool_body,
    estimate_prompt_tokens,
    futile_hint,
    internal_call,
    kept_messages,
    message_chars,
    overflow_elisions,
    overflow_info,
    packs_out_of_view,
    pinned_request,
    prompt_overhead_chars,
    render_view,
    request_text,
    stale_edit_refusal,
    summary_prompt,
    thinking_budget_tokens,
    tool_output_cap_chars,
    truncate_tool_result,
)
from clara_coder_backend.lang_agent.subagents import REPORTS_ARRIVED_HEADER
from clara_coder_backend.llm.messages import USER_TURN_KEY

CFG = RuntimeContextCompressionConfig()
IMAGE = {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA'}}


def user(text: Any, message_id: str = 'u1') -> HumanMessage:
    return HumanMessage(content=text, id=message_id, additional_kwargs={USER_TURN_KEY: True})


def ai_call(
    call_id: str, name: str = 'read_thing', args: dict | None = None, message_id: str | None = None
) -> AIMessage:
    return AIMessage(
        content='',
        id=message_id or f'a-{call_id}',
        tool_calls=[
            {'name': name, 'args': args if args is not None else {'path': 'x'}, 'id': call_id, 'type': 'tool_call'}
        ],
    )


def result(call_id: str, body: str = 'ok', name: str = 'read_thing', message_id: str | None = None) -> ToolMessage:
    return ToolMessage(content=body, tool_call_id=call_id, name=name, id=message_id or f't-{call_id}')


def read_body(path: str = 'a.py', first: int = 1, last: int = 220, total: int = 900, gutter: bool = True) -> str:
    header = f'File: {path}\nEncoding: utf-8\nLines: {first}-{last} (of {total} in file)\n\n'
    lines = [f'{n:>4} │ line {n}' if gutter else f'line {n}' for n in range(first, last + 1)]
    return header + '\n'.join(lines)


def ids(messages: list[Any]) -> list[str | None]:
    return [message.id for message in messages]


def round_of(call_id: str, size: int) -> list[Any]:
    return [ai_call(call_id), result(call_id, 'b' * size)]


def refused(call_id: str, name: str = 'write_workspace_file', message_id: str | None = None) -> ToolMessage:
    """The ToolNode's answer to a call it never ran: no prefix a tool's own failure has, only the status."""
    body = f"Error invoking tool '{name}' with kwargs {{}} with error:\n content: Field required\n Please fix the error"
    return ToolMessage(content=body, tool_call_id=call_id, name=name, status='error', id=message_id or f't-{call_id}')


def _shortened_read(
    path: str = 'big.py', first: int = 1, last: int = 220, total: int = 900, cap: int = 1000
) -> tuple[str, int]:
    """A read the tool budget cut, with its ``Lines:`` header intact, and the last line it still shows."""
    body = truncate_tool_result('read_workspace_file', read_body(path, first, last, total), cap)
    assert f'Lines: {first}-{last} (of {total} in file)' in body
    note = body.rsplit('call again with start_line=', 1)[1]
    return body, int(note.split('.', 1)[0]) - 1


# ---------------------------------------------------------------------------
# Sizes and estimate
# ---------------------------------------------------------------------------


def test_message_chars_counts_content_and_call_json() -> None:
    assert message_chars(HumanMessage(content='hello')) == 5
    message = ai_call('c1', args={'path': 'é'})
    expected = len(json.dumps(message.tool_calls, ensure_ascii=False))
    assert message_chars(message) == expected
    assert message_chars(AIMessage(content='hey', tool_calls=message.tool_calls)) == 3 + expected


def test_message_chars_images_cost_1500_tokens_whatever_their_bytes() -> None:
    small = HumanMessage(content=[{'type': 'text', 'text': 'look'}, IMAGE])
    assert message_chars(small) == 4 + int(1500 * CHARS_PER_TOKEN)
    huge = HumanMessage(content=[{'type': 'image_url', 'image_url': {'url': 'x' * 5_000_000}}])
    assert message_chars(huge) == int(1500 * CHARS_PER_TOKEN)


def test_message_chars_counts_claude_thinking_blocks() -> None:
    message = AIMessage(content=[{'type': 'thinking', 'thinking': 'abcd'}, {'type': 'text', 'text': 'ef'}])
    assert message_chars(message) == 6


def test_overhead_is_the_system_prompt_and_the_tool_schemas() -> None:
    @tool
    def probe(path: str) -> str:
        """Probe."""
        return path

    system = HumanMessage(content='s' * 100)
    with_tool = prompt_overhead_chars(system, [probe])
    assert with_tool > 100 + len('probe')
    assert prompt_overhead_chars(system, []) == 100
    assert prompt_overhead_chars(None, [{'type': 'function', 'function': {'name': 'n'}}]) > 0


def test_estimate_without_reading_uses_chars_over_3_2() -> None:
    view = [user('x' * 320)]
    assert estimate_prompt_tokens(view, {}, 0) == (100, CHARS_PER_TOKEN)
    assert estimate_prompt_tokens(view, {}, 320) == (200, CHARS_PER_TOKEN)


def _reply_with_reading(tokens: int, text: str = '') -> AIMessage:
    return AIMessage(
        content=text,
        id=f'r{tokens}',
        usage_metadata={'input_tokens': tokens, 'output_tokens': 1, 'total_tokens': tokens + 1},
    )


def test_estimate_prices_what_came_since_the_newest_reading() -> None:
    # 4000 chars were 1000 tokens: 4 chars per token. Then 400 chars more.
    view = [user('x' * 3000), _reply_with_reading(1000), result('c', 'y' * 400)]
    est, ratio = estimate_prompt_tokens(view, {}, 1000)
    assert ratio == 4.0
    assert est == 1100


def test_estimate_clamps_the_ratio() -> None:
    assert estimate_prompt_tokens([user('x' * 100), _reply_with_reading(1000)], {}, 0)[1] == 2.5
    assert estimate_prompt_tokens([user('x' * 100_000), _reply_with_reading(1000)], {}, 0)[1] == 5.0


def test_estimate_ignores_readings_before_the_floor() -> None:
    """A reading from before the last event measured a prompt that no longer exists."""
    before_floor = _reply_with_reading(9000)
    last = result('c', 'y' * 320, message_id='floor')
    view = [user('x' * 320), before_floor, last]
    assert estimate_prompt_tokens(view, {'floor_id': 'floor'}, 0) == (200, CHARS_PER_TOKEN)
    # After the floor it counts again.
    fresh = _reply_with_reading(500)
    assert estimate_prompt_tokens([*view, fresh], {'floor_id': 'floor'}, 0)[0] == 500


def test_estimate_with_a_floor_out_of_view_has_no_reading() -> None:
    view = [user('x' * 320), _reply_with_reading(9000)]
    assert estimate_prompt_tokens(view, {'floor_id': 'gone'}, 0) == (100, CHARS_PER_TOKEN)


def test_corrected_ratio_comes_from_the_servers_count() -> None:
    assert corrected_ratio([user('x' * 3000)], 1000, 1000) == 4.0
    assert corrected_ratio([user('x' * 10)], 0, 1000) == 2.5


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


def test_budget_at_32k_with_the_usual_overhead() -> None:
    budget = compute_budget(32768, 9000, 0, 500, 1000, CFG)
    assert budget.reserve == 4915
    assert budget.target == 16384
    assert budget.trigger == 26214
    assert budget.tail == 16384 - 10500
    assert budget.has_room_for_notes


def test_budget_keeps_a_reachable_target_when_fixed_parts_exceed_the_ratio() -> None:
    """At 16K, the overhead alone is past the 50% target: the tail still gets its share."""
    budget = compute_budget(16384, 8900, 0, 500, 1000, CFG)
    assert budget.target == 8900 + 500 + 1000 + 2000
    assert budget.tail == 2000
    # And the soft trigger stays above where an event lands.
    assert budget.trigger == budget.target + int(0.15 * 16384)
    assert not budget.has_room_for_notes


def test_budget_pin_takes_from_the_target_not_the_tail_floor() -> None:
    without = compute_budget(32768, 9000, 0, 500, 1000, CFG)
    pinned = compute_budget(32768, 9000, 8000, 500, 1000, CFG)
    assert pinned.tail < without.tail
    assert pinned.tail >= int(0.12 * 32768)


def test_budget_reserve_is_clamped() -> None:
    assert compute_budget(4000, 0, 0, 0, 0, CFG).reserve == 2048
    assert compute_budget(1_000_000, 0, 0, 0, 0, CFG).reserve == 16000


def test_compaction_due_hard_and_soft() -> None:
    budget = compute_budget(32768, 9000, 0, 500, 1000, CFG)
    assert not compaction_due(budget.trigger - 1, budget, {})
    assert compaction_due(budget.trigger, budget, {})
    # Soft waits for the last event's gap; hard does not.
    assert not compaction_due(budget.trigger, budget, {'next_soft': budget.trigger + 1})
    assert compaction_due(32768 - budget.reserve, budget, {'next_soft': 99_999})
    assert compaction_due(0, budget, {'force': True})


def test_digest_cap_is_clamped() -> None:
    assert digest_cap_chars(1000) == 1500
    assert digest_cap_chars(16384) == int(0.1 * 16384 * 3.2)
    assert digest_cap_chars(1_000_000) == 8000


def test_thinking_budget_follows_the_room_within_its_bounds() -> None:
    assert thinking_budget_tokens(20000, 10000) == int((20000 - 10000 - 2048) * 0.6)
    assert thinking_budget_tokens(32768, 32000) == 512
    assert thinking_budget_tokens(1_000_000, 1000) == 8192


def test_thinking_budget_leaves_room_for_the_answer_under_a_settings_cap() -> None:
    assert thinking_budget_tokens(65536, 20000, 6000) == 2000
    # Below the floor too: the floor would sit at or above a very small cap.
    assert thinking_budget_tokens(65536, 20000, 1024) == 341
    # The room left still bounds it, and a large cap changes nothing.
    assert thinking_budget_tokens(32768, 32000, 6000) == 512
    assert thinking_budget_tokens(1_000_000, 1000, 100_000) == 8192


def _request(model_extra: dict | None = None, settings: dict | None = None, **rest: Any) -> Any:
    class Request(SimpleNamespace):
        def override(self, **changes: Any) -> Any:
            return Request(**{**self.__dict__, **changes})

    return Request(
        model=SimpleNamespace(extra_body=model_extra),
        model_settings=settings or {},
        messages=[],
        tool_choice=None,
        **rest,
    )


def test_thinking_bound_is_llamacpp_only_and_merges_the_model_extra_body() -> None:
    request = _request({'top_k': 40}, {'parallel_tool_calls': True})
    settings = bounded_step_settings(request, 'llamacpp', 32768, 10000)
    assert settings['parallel_tool_calls'] is True
    assert settings['extra_body']['top_k'] == 40
    assert settings['extra_body']['reasoning_budget_tokens'] == thinking_budget_tokens(32768, 10000)
    assert settings['extra_body']['reasoning_budget_message'] == 'I have thought enough. I will act now on what I have.'
    for provider in ('openai', 'openrouter', 'anthropic'):
        assert bounded_step_settings(request, provider, 32768, 10000) is request.model_settings
    # LM Studio has no thinking budget, only the output cap.
    assert 'reasoning_budget_tokens' not in bounded_step_settings(request, 'lmstudio', 32768, 10000)['extra_body']


def test_step_output_cap_is_local_only_and_yields_to_settings() -> None:
    request = _request({'top_k': 40}, {})
    for provider in ('llamacpp', 'lmstudio'):
        settings = bounded_step_settings(request, provider, 32768, 10000)
        assert settings['max_tokens'] == settings['extra_body']['max_tokens'] == 24576
    request.model.max_tokens = 4096
    settings = bounded_step_settings(request, 'llamacpp', 32768, 10000)
    assert 'max_tokens' not in settings
    assert 'max_tokens' not in settings['extra_body']


def test_thinking_bound_follows_a_settings_output_cap() -> None:
    request = _request({'top_k': 40}, {})
    assert bounded_step_settings(request, 'llamacpp', 65536, 20000)['extra_body']['reasoning_budget_tokens'] == 8192
    request.model.max_tokens = 6000
    assert bounded_step_settings(request, 'llamacpp', 65536, 20000)['extra_body']['reasoning_budget_tokens'] == 2000


# ---------------------------------------------------------------------------
# The cut
# ---------------------------------------------------------------------------


def test_cut_keeps_rounds_from_the_newest_while_they_fit() -> None:
    messages = [user('go'), *round_of('c1', 1000), *round_of('c2', 1000), *round_of('c3', 1000)]
    # Room for the newest two whole rounds and not the stub of the third.
    assert choose_cut(messages, 2200 / 4, 4.0) == 'a-c2'


def test_cut_never_splits_the_newest_round() -> None:
    messages = [user('go'), ai_call('c1'), result('c1', 'b' * 9000), result('c1b', 'b' * 9000)]
    assert choose_cut(messages, 10, 4.0) == 'a-c1'


def test_cut_lets_one_round_cross_when_its_stub_fits() -> None:
    """Its bodies are elided next, and the model still sees what it did just before."""
    messages = [user('go'), *round_of('c1', 1000), *round_of('c2', 5000), *round_of('c3', 100)]
    assert choose_cut(messages, 1500, 1.0) == 'a-c2'
    # No room for its stub: it goes.
    assert choose_cut(messages, 200, 1.0) == 'a-c3'


def test_cut_returns_the_first_message_when_everything_fits() -> None:
    messages = [user('go'), *round_of('c1', 10)]
    assert choose_cut(messages, 10_000, 4.0) == 'u1'


def test_cut_does_not_start_at_a_plain_ai_message() -> None:
    messages = [user('first'), AIMessage(content='a' * 100, id='plain'), user('second', 'u2')]
    assert choose_cut(messages, 10, 1.0) == 'u2'
    # The plain answer belongs to the round before it.
    messages = [
        user('first'),
        *round_of('c1', 100),
        AIMessage(content='answer', id='plain'),
        HumanMessage(content='note', id='n'),
    ]
    assert choose_cut(messages, 10, 1.0) == 'a-c1'


def test_cut_only_at_messages_with_ids() -> None:
    messages = [
        user('first'),
        *round_of('c1', 100),
        AIMessage(content='', tool_calls=ai_call('c2').tool_calls, id=None),
    ]
    assert choose_cut(messages, 10, 1.0) == 'a-c1'


def test_cut_opens_at_old_preamble_turns_but_not_at_notes() -> None:
    old_turn = HumanMessage(content='**Session truth (x):**\n- a\n\nrequest', id='old')
    note = HumanMessage(content='A report arrived.', id='note')
    messages = [user('first'), AIMessage(content='a' * 200, id='plain'), note, old_turn]
    assert choose_cut(messages, 1, 1.0) == 'old'
    messages = [user('first'), AIMessage(content='a' * 200, id='plain'), note]
    assert choose_cut(messages, 1, 1.0) == 'u1'


def test_cut_with_no_possible_start() -> None:
    assert choose_cut([HumanMessage(content='note', id='n'), AIMessage(content='plain', id='p')], 1, 1.0) is None
    assert choose_cut([], 1, 1.0) is None


def test_elisions_start_with_the_oldest_and_stop_when_it_fits() -> None:
    tail = [*round_of('c1', 4000), *round_of('c2', 4000), *round_of('c3', 4000)]
    out = choose_elisions(tail, 9000, 1.0, [], 100_000)
    assert out == ['t-c1']
    out = choose_elisions(tail, 4000, 1.0, [], 100_000)
    assert out == ['t-c1', 't-c2']


def test_elisions_never_touch_the_newest_round() -> None:
    tail = [*round_of('c1', 100), *round_of('c2', 100_000)]
    assert choose_elisions(tail, 10, 1.0, [], 100_000) == []


def test_elisions_count_a_plain_note_round_as_the_newest() -> None:
    """After a truncated reply the newest round is its marker and note: the result before it can go."""
    tail = [
        *round_of('c1', 50_000),
        AIMessage(content='[Reply discarded]', id='marker'),
        HumanMessage(content='note', id='n'),
    ]
    assert choose_elisions(tail, 1000, 1.0, [], 100_000) == ['t-c1']


def test_elisions_skip_what_gains_little_and_what_is_already_elided() -> None:
    tail = [*round_of('c1', 150), *round_of('c2', 5000), *round_of('c3', 10)]
    assert choose_elisions(tail, 10, 1.0, [], 100_000) == ['t-c2']
    assert choose_elisions(tail, 10, 1.0, ['t-c2'], 100_000) == []


def test_elisions_replace_images_in_human_messages() -> None:
    vision = HumanMessage(content=[{'type': 'text', 'text': 'Vision input'}, IMAGE], id='vision')
    tail = [ai_call('c1'), result('c1'), vision, *round_of('c2', 10)]
    assert choose_elisions(tail, 100, 1.0, [], 100_000) == ['vision']


def test_overflow_elisions_reach_the_newest_round() -> None:
    giant_user = user('q' * 5000, 'giant')
    small_user = user('q', 'small')
    write = ai_call('w', 'write_workspace_file', {'relative_path': 'a', 'content': 'c' * 3000})
    small_write = ai_call('w2', 'write_workspace_file', {'relative_path': 'a', 'content': 'c' * 10})
    tail = [giant_user, small_user, write, result('w'), small_write, result('w2', 'r' * 9000)]
    assert overflow_elisions(tail, [], 1000, 8000) == ['giant', 'a-w', 't-w2']
    assert overflow_elisions(tail, ['giant', 'a-w'], 1000, 8000) == ['t-w2']


# ---------------------------------------------------------------------------
# Placeholders
# ---------------------------------------------------------------------------


def test_read_placeholder_names_the_span() -> None:
    message = result('c', read_body('src/a.py', 1, 220, 900), 'read_workspace_file')
    assert (
        elided_tool_body(message)
        == '[Removed to save context: `src/a.py` lines 1-220 of 900. Re-read only if needed now.]'
    )


def test_read_placeholder_sees_through_a_context_pack_in_front() -> None:
    body = '---\nContext pack `pdf` (activated):\nplaybook\n---\n' + read_body('a.py', 5, 9, 20)
    message = result('c', body, 'read_workspace_file')
    assert elided_tool_body(message).startswith('[Removed to save context: `a.py` lines 5-9 of 20.')


def test_read_placeholder_of_a_shortened_read_names_what_it_showed() -> None:
    body, shown = _shortened_read(first=221, last=600, total=600)
    message = result('c', body, 'read_workspace_file')
    assert elided_tool_body(message) == (
        f'[Removed to save context: `big.py` lines 221-{shown} of 600. Re-read only if needed now.]'
    )


def test_command_placeholder_keeps_status_and_tail() -> None:
    body = (
        'Command report:\n- Command id: `1`\n- Command: `npm test`\n- Status: exited with code 1 after 12s\n\n'
        + ''.join(f'output line {n}\n' for n in range(1000))
        + 'FAILED: the last line'
    )
    placeholder = elided_tool_body(result('c', body, 'run_command'))
    lines = placeholder.split('\n')
    assert lines[0] == '- Status: exited with code 1 after 12s'
    assert lines[-2] == 'FAILED: the last line'
    assert lines[-1] == '[Shortened to save context. Cannot be fetched again; re-run if needed.]'
    assert len(placeholder) < 800
    # Whole lines only.
    assert lines[1].startswith('output line')


def test_other_results_keep_a_tail_and_the_note() -> None:
    placeholder = elided_tool_body(result('c', 'grep hit\n' * 1000, 'search_workspace'))
    assert 'Status' not in placeholder
    assert placeholder.endswith('[Shortened to save context. Cannot be fetched again; re-run if needed.]')


def test_placeholders_are_stable_and_do_not_touch_the_original() -> None:
    message = result('c', read_body(), 'read_workspace_file')
    original = message.content
    first = elided_message(message, 1000)
    second = elided_message(message, 1000)
    assert first is not message
    assert first.content == second.content
    assert message.content == original


def test_giant_write_args_are_replaced_and_the_rest_stays() -> None:
    message = ai_call(
        'w', 'write_workspace_file', {'relative_path': 'a.py', 'content': 'c' * 5000, 'encoding': 'utf-8'}
    )
    copy = elided_message(message, 1000)
    args = copy.tool_calls[0]['args']
    assert args['relative_path'] == 'a.py'
    assert args['encoding'] == 'utf-8'
    assert args['content'].startswith('[Removed to save context: 5000 chars.')
    assert message.tool_calls[0]['args']['content'] == 'c' * 5000


def test_request_cap_keeps_head_and_tail_with_the_note() -> None:
    copy = elided_message(user('H' * 500 + 'm' * 9000 + 'T' * 500), 3000)
    assert copy.content.startswith('H' * 500)
    assert copy.content.endswith('T' * 500)
    assert '[7000 chars removed for size. Ask the user for a file if needed.]' in copy.content
    assert copy.additional_kwargs[USER_TURN_KEY] is True


def test_request_cap_on_multimodal_applies_to_text_and_removes_images() -> None:
    copy = elided_message(user([{'type': 'text', 'text': 'x' * 9000}, IMAGE]), 300)
    assert len(copy.content[0]['text']) < 500
    assert copy.content[1] == {'type': 'text', 'text': IMAGE_REMOVED_TEXT}


def test_vision_message_keeps_its_text_when_the_image_goes() -> None:
    copy = elided_message(HumanMessage(content=[{'type': 'text', 'text': 'x' * 900}, IMAGE]), 300)
    assert copy.content[0]['text'] == 'x' * 900
    assert copy.content[1] == {'type': 'text', 'text': IMAGE_REMOVED_TEXT}


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def test_view_is_the_messages_until_there_is_a_cut() -> None:
    messages = [user('go'), *round_of('c1', 10)]
    assert render_view(messages, {}, 1000) is messages


def test_block_opens_the_view_as_its_own_message_before_an_ai_message() -> None:
    messages = [user('go'), *round_of('c1', 10), *round_of('c2', 10)]
    view = render_view(messages, {'cut_id': 'a-c2', 'block': 'BLOCK'}, 1000)
    assert isinstance(view[0], HumanMessage)
    assert view[0].content == 'BLOCK'
    assert ids(view[1:]) == ['a-c2', 't-c2']


def test_block_merges_into_a_first_human_message_as_a_copy() -> None:
    first = user('second request', 'u2')
    messages = [user('go'), AIMessage(content='answer', id='a'), first, *round_of('c1', 10)]
    view = render_view(messages, {'cut_id': 'u2', 'block': 'BLOCK'}, 1000)
    assert view[0].content == 'BLOCK\n\nsecond request'
    assert view[0].id == 'u2'
    assert view[0] is not first
    assert first.content == 'second request'
    assert view[0].additional_kwargs[USER_TURN_KEY] is True


def test_block_merges_into_a_multimodal_message_as_a_prepended_part() -> None:
    first = user([{'type': 'text', 'text': 'look'}, IMAGE], 'u2')
    view = render_view([user('go'), first], {'cut_id': 'u2', 'block': 'BLOCK'}, 1000)
    assert view[0].content == [{'type': 'text', 'text': 'BLOCK'}, {'type': 'text', 'text': 'look'}, IMAGE]
    assert len(first.content) == 2


def test_rendering_twice_gives_the_same_bytes() -> None:
    messages = [user('go'), *round_of('c1', 5000), *round_of('c2', 10)]
    cc = {'cut_id': 'a-c1', 'block': 'BLOCK', 'elided_ids': ['t-c1']}

    def dump(view: list[Any]) -> str:
        return json.dumps([[m.content, getattr(m, 'tool_calls', None)] for m in view])

    assert dump(render_view(messages, cc, 1000)) == dump(render_view(messages, cc, 1000))


def test_elided_ids_apply_in_the_view_and_never_in_place() -> None:
    body = read_body()
    messages = [
        user('go'),
        ai_call('c1', 'read_workspace_file'),
        result('c1', body, 'read_workspace_file'),
        *round_of('c2', 10),
    ]
    view = render_view(messages, {'cut_id': 'a-c1', 'block': 'B', 'elided_ids': ['t-c1']}, 1000)
    assert view[2].content.startswith('[Removed to save context')
    assert messages[2].content == body


def test_a_lost_cut_shows_everything_and_no_block() -> None:
    messages = [user('go'), *round_of('c1', 10)]
    view = render_view(messages, {'cut_id': 'gone', 'block': 'BLOCK'}, 1000)
    assert ids(view) == ids(messages)
    assert view[0].content == 'go'


def test_notes_without_ids_stay_at_the_end_of_the_view() -> None:
    note = HumanMessage(content='a per-call note')
    messages = [user('go'), *round_of('c1', 10), note]
    view = render_view(messages, {'cut_id': 'a-c1', 'block': 'B'}, 1000)
    assert view[-1] is note


def test_kept_messages_have_no_block() -> None:
    messages = [user('go'), *round_of('c1', 10)]
    kept = kept_messages(messages, {'cut_id': 'a-c1', 'block': 'B'}, 1000)
    assert ids(kept) == ['a-c1', 't-c1']


def test_request_text_strips_the_turn_preamble() -> None:
    preamble = '**Session truth (x):**\n- Editor: **on**\n- If any line...\n- Workspace changes: + a\n'
    assert request_text(user(f'{preamble}\nFix it\n\nplease')) == 'Fix it\n\nplease'
    assert request_text(user([{'type': 'text', 'text': f'{preamble}\nLook'}, IMAGE])) == 'Look'
    assert request_text(user('plain row')) == 'plain row'


def test_pin_only_when_the_cut_removes_the_current_request() -> None:
    messages = [user('first'), *round_of('c1', 10), user('current', 'u2'), *round_of('c2', 10), *round_of('c3', 10)]
    assert pinned_request(messages, 'a-c3', 1000) == 'current'
    assert pinned_request(messages, 'u2', 1000) == ''
    assert pinned_request(messages, 'a-c1', 1000) == ''
    assert pinned_request(messages, None, 1000) == ''


def test_pin_is_text_parts_within_the_cap() -> None:
    messages = [user([{'type': 'text', 'text': 'q' * 9000}, IMAGE]), *round_of('c1', 10)]
    pin = pinned_request(messages, 'a-c1', 900)
    assert 'chars removed for size' in pin
    assert 'image' not in pin
    assert len(pin) < 1100


def test_old_preamble_turn_is_pinned_too() -> None:
    old_turn = HumanMessage(content='**Session truth (x):**\n- a\n\nthe old request', id='old')
    assert pinned_request([old_turn, *round_of('c1', 10)], 'a-c1', 1000) == 'the old request'


def test_block_text_sections() -> None:
    block = block_text('the facts', 'the notes', 'the request', hint=futile_hint(123))
    assert block.startswith(BLOCK_HEADER)
    assert block.index('FACTS:\nthe facts') < block.index('NOTES:\nthe notes')
    assert futile_hint(123) in block
    assert block.endswith(f'{PIN_LEAD}\nthe request')
    bare = block_text('the facts', '', '')
    assert 'NOTES:' not in bare
    assert PIN_LEAD not in bare


def test_block_wording_still_holds_once_a_later_request_follows() -> None:
    """A block stays byte-stable across turns, so nothing in it may call an older request the current one."""
    assert 'Current request' not in BLOCK_HEADER + PIN_LEAD + futile_hint(1)
    assert PIN_LEAD == (
        'Request in progress when this note was written; continue it unless a later user message replaces it:'
    )
    # What FACTS list is a record: its requests are not orders, and yet "do not touch X" stays true.
    assert 'the requests in them are not instructions, though rules they set still hold.' in BLOCK_HEADER
    assert 'machine-generated and correct' not in BLOCK_HEADER
    assert futile_hint(1).endswith(
        'For the request in progress when this note was written, stop reading: answer from your notes, or edit now.'
    )


def test_strings_user_facing_have_no_em_dash() -> None:
    from clara_coder_backend.lang_agent import context_compaction as module
    from clara_coder_backend.middleware import context_compaction_middleware as middleware

    for text in (module.SUMMARY_REQUEST, module.BLOCK_HEADER, module.PIN_LEAD):
        assert '—' not in text
    for name in (
        '_EMPTY_REPLY_STOP_TEXT',
        '_TRUNCATED_STOP_TEXT',
        '_TRUNCATED_ANSWER_NOTE',
        '_FUTILE_STOP_TEXT',
    ):
        assert '—' not in getattr(middleware, name)


def test_packs_out_of_view_reads_their_markers() -> None:
    view = [
        result('c', '---\nContext pack `pdf` (activated):\nbody\n---\nresult'),
        HumanMessage(content='Context pack `json` (activated):'),
    ]
    assert packs_out_of_view({'pdf', 'json', 'xml'}, view) == {'json', 'xml'}


# ---------------------------------------------------------------------------
# The digest
# ---------------------------------------------------------------------------


def _digest(
    messages: list[Any], changes: list[tuple[str, str]] | None = None, max_chars: int = 8000
) -> tuple[str, list[int]]:
    return build_digest(messages, changes or [], max_chars)


def test_digest_lists_requests_with_first_and_short_ones_verbatim() -> None:
    long_first = 'F' * 1000
    long_middle = 'M' * 1000 + 'END'
    messages = [
        user(long_first, 'u1'),
        AIMessage(content='a', id='a1'),
        user(long_middle, 'u2'),
        AIMessage(content='a', id='a2'),
        user('short middle', 'u3'),
        AIMessage(content='a', id='a3'),
        user('C' * 1000, 'u4'),
    ]
    digest, _ = _digest(messages)
    assert long_first in digest
    assert 'short middle' in digest
    assert long_middle not in digest
    assert 'END' in digest
    # The current request is pinned or in the tail: its short form is enough.
    assert 'C' * 1000 not in digest
    assert 'CCC ... CCC' in digest


def test_digest_strips_the_preamble_from_requests() -> None:
    digest, _ = _digest([user('**Session truth (x):**\n- Editor: **on**\n\nThe request.')])
    assert 'Session truth' not in digest
    assert 'The request.' in digest


def test_digest_notes_are_not_requests() -> None:
    digest, _ = _digest([user('real'), HumanMessage(content='A note for the model.', id='n')])
    assert 'A note for the model' not in digest


def test_digest_pairs_results_by_position_when_call_ids_repeat() -> None:
    """Pseudo-XML calls get ``xml-tool-1`` every time: only position says which call a result answers."""
    read = ai_call('xml-tool-1', 'read_workspace_file', {'relative_path': 'read.py'}, 'a1')
    write = ai_call('xml-tool-1', 'write_workspace_file', {'relative_path': 'written.py', 'content': 'x'}, 'a2')
    failed_write = ai_call('xml-tool-1', 'write_workspace_file', {'relative_path': 'failed.py', 'content': 'x'}, 'a3')
    messages = [
        user('go'),
        read,
        result('xml-tool-1', read_body('read.py'), 'read_workspace_file', 't1'),
        write,
        result('xml-tool-1', 'Created `written.py` (full-file; 0 → 1 lines).', 'write_workspace_file', 't2'),
        failed_write,
        result('xml-tool-1', 'Tool error: no.', 'write_workspace_file', 't3'),
    ]
    digest, progress = _digest(messages)
    assert 'Files edited: written.py' in digest
    assert 'failed.py' not in digest
    assert 'Files read: read.py (lines 1-220 of 900)' in digest
    assert progress == [1, 0, 220, 0]


def test_digest_a_result_answers_the_ai_message_before_it_even_if_an_earlier_call_stayed_open() -> None:
    lost_write = ai_call('xml-tool-1', 'write_workspace_file', {'relative_path': 'lost.py', 'content': 'x'}, 'a1')
    read = ai_call('xml-tool-1', 'read_workspace_file', {'relative_path': 'found.py'}, 'a2')
    digest, progress = _digest(
        [user('go'), lost_write, read, result('xml-tool-1', read_body('found.py'), 'read_workspace_file')]
    )
    assert 'lost.py' not in digest
    assert 'Files read: found.py (lines 1-220 of 900)' in digest
    assert progress == [0, 0, 220, 0]


def test_digest_tool_errors_are_not_edits_or_reads() -> None:
    edit = ai_call('e', 'replace_workspace_lines', {'relative_path': 'a.py', 'start_line': 1, 'end_line': 2})
    interrupted = ai_call('i', 'write_workspace_file', {'relative_path': 'b.py', 'content': 'x'})
    read = ai_call('r', 'read_workspace_file', {'relative_path': 'c.py'})
    messages = [
        user('go'),
        edit,
        result('e', 'Tool error: `a.py` lines 1-2 are not in your context.'),
        interrupted,
        result('i', 'Interrupted: the user stopped this turn before this call finished; no result.'),
        read,
        result('r', 'Tool note: `c.py` does not exist.'),
    ]
    digest, progress = _digest(messages)
    assert 'Files edited' not in digest
    assert 'Files read' not in digest
    assert progress == [0, 0, 0, 0]


def test_digest_a_write_that_changed_nothing_is_not_an_edit() -> None:
    """Counted as progress, a model rewriting one file could never reach the stop made for that loop."""
    write = ai_call('w', 'write_workspace_file', {'relative_path': 'a.py', 'content': 'x'})
    messages = [user('go'), write, result('w', 'No change: `a.py` already has exactly this content, so nothing was written.')]
    digest, progress = _digest(messages)
    assert 'Files edited' not in digest
    assert progress == [0, 0, 0, 0]


def test_digest_calls_the_tool_node_refused_are_not_edits_or_reads() -> None:
    """A validation error or an unbound tool wrote nothing, and repeating one must not look like progress."""
    no_content = ai_call('w', 'write_workspace_file', {'relative_path': 'a.py'})
    no_end_line = ai_call('e', 'replace_workspace_lines', {'relative_path': 'b.py', 'start_line': 1})
    unbound = ai_call('s', 'replace_workspace_snippet', {'relative_path': 'c.py', 'old_snippet': 'x'})
    not_a_tool = ToolMessage(
        content='Error: replace_workspace_snippet is not a valid tool, try one of [read_workspace_file].',
        tool_call_id='s',
        name='replace_workspace_snippet',
        status='error',
        id='t-s',
    )
    read = ai_call('r', 'read_workspace_file', {'relative_path': 'd.py'})
    fetch = ai_call('f', 'fetch_url', {'url': 'http://x'})
    digest, progress = _digest(
        [
            user('go'),
            no_content,
            refused('w'),
            no_end_line,
            refused('e', 'replace_workspace_lines'),
            unbound,
            not_a_tool,
            read,
            refused('r', 'read_workspace_file'),
            fetch,
            refused('f', 'fetch_url'),
        ]
    )
    assert 'Files edited' not in digest
    assert 'Files read' not in digest
    assert progress == [0, 0, 0, 0]


@pytest.mark.parametrize('bad_line', [[1], {'from': 1}])
def test_digest_takes_a_read_with_a_line_argument_that_cannot_be_hashed(bad_line: Any) -> None:
    """A local model's ``start_line: [1]``: the tool never ran, and it must cost one tool error, not the next event."""
    bad_start = ai_call('r1', 'read_workspace_file', {'relative_path': 'notes.txt', 'start_line': bad_line})
    bad_end = ai_call('r2', 'read_workspace_file', {'relative_path': 'notes.txt', 'end_line': bad_line})
    digest, progress = _digest(
        [
            user('go'),
            bad_start,
            refused('r1', 'read_workspace_file'),
            bad_end,
            refused('r2', 'read_workspace_file'),
        ]
    )
    assert 'notes.txt' not in digest
    assert progress == [0, 0, 0, 0]
    # A context pack put in front of the error drops its status (a first read of a ``.pdf``): no crash that way either.
    with_pack = f"---\nContext pack `pdf` (activated):\nplaybook\n---\n{refused('r1').content}"
    _, progress = _digest([user('go'), bad_start, result('r1', with_pack, 'read_workspace_file')])
    assert progress == [0, 0, 1, 0]


_PENDING_DELETE = (
    'Pending user confirmation: `vendor` is too large to restore after the turn, so the user is asked before '
    'anything is removed.'
)


@pytest.mark.parametrize(
    ('answer', 'ran'),
    [
        ('Deleted directory `vendor` and its contents.', True),
        ('User cancelled the delete request.', False),
        ('Delete confirmation ignored (stale or mismatched request).', False),
        ('Delete failed:\nDelete failed for `vendor`: denied', False),
        ('Nothing to delete (paths were already removed).', False),
    ],
)
def test_digest_a_delete_that_asked_first_counts_only_if_its_answer_says_it_ran(answer: str, ran: bool) -> None:
    delete = ai_call('d', 'delete_workspace_entries', {'relative_paths': ['vendor'], 'recursive': True})
    answered_after = [
        user('go'),
        delete,
        result('d', _PENDING_DELETE, 'delete_workspace_entries'),
        HumanMessage(content=answer, id='answer'),
    ]
    # A turn stopped at the card folds its answer into the result.
    folded = [user('go'), delete, result('d', f'{_PENDING_DELETE}\n\n---\n{answer}', 'delete_workspace_entries')]
    for messages in (answered_after, folded):
        digest, progress = _digest(messages)
        assert ('Files edited: vendor' in digest) is ran
        assert progress[0] == int(ran)


def test_digest_a_delete_nobody_answered_is_not_an_edit() -> None:
    delete = ai_call('d', 'delete_workspace_entries', {'relative_paths': ['vendor']})
    pending = result('d', _PENDING_DELETE, 'delete_workspace_entries')
    for messages in ([user('go'), delete, pending], [user('go'), delete, pending, user('never mind', 'u2')]):
        digest, progress = _digest(messages)
        assert 'Files edited' not in digest
        assert progress[0] == 0


def test_digest_an_approved_page_is_still_new_work() -> None:
    """Approved web and MCP results start with the same words as a staged delete: they count as new reads."""
    fetch = ai_call('f', 'fetch_url', {'url': 'http://x'})
    body = 'Pending user confirmation for `fetch_url`.\n\n---\nThe page text.'
    assert _digest([user('go'), fetch, result('f', body, 'fetch_url')])[1] == [0, 0, 1, 0]


def test_digest_edits_cover_snippets_deletes_and_copies() -> None:
    snippet = ai_call('s', 'replace_workspace_snippet', {'relative_path': 'snip.py'})
    delete = ai_call('d', 'delete_workspace_entries', {'relative_paths': ['gone.py', 'gone2.py']})
    copy = ai_call('c', 'copy_workspace_files', {'copies': [{'source_path': 'x', 'destination_path': 'copied.py'}]})
    messages = [
        user('go'),
        snippet,
        result('s', 'Updated'),
        delete,
        result('d', 'Deleted'),
        copy,
        result('c', 'Copied'),
    ]
    digest, progress = _digest(messages)
    assert 'Files edited: snip.py, gone.py, gone2.py, copied.py' in digest
    assert progress[0] == 3


def test_digest_paths_are_one_file_however_spelled() -> None:
    first = ai_call('a', 'read_workspace_file', {'relative_path': 'src/a.py'})
    second = ai_call('b', 'read_workspace_file', {'relative_path': './src/a.py'})
    third = ai_call('c', 'read_workspace_file', {'relative_path': 'src\\a.py'})
    messages = [user('go'), first, result('a'), second, result('b'), third, result('c')]
    digest, progress = _digest(messages)
    assert progress[2] == 1
    assert digest.count('a.py') == 1


def _command(call_id: str, command: str, status: str) -> list[Any]:
    body = f'Command report:\n- Command id: `{call_id}`\n- Command: `{command}`\n- Status: {status}\n\nout'
    return [ai_call(call_id, 'run_command', {'command': command}), result(call_id, body, 'run_command')]


def test_digest_keeps_the_last_five_commands_with_status() -> None:
    messages = [user('go')]
    for number in range(7):
        messages += _command(f'c{number}', f'cmd-{number}', f'exited with code {number} after 1s')
    digest, progress = _digest(messages)
    assert 'cmd-1' not in digest
    assert '`cmd-2`: exited with code 2 after 1s' in digest
    assert '`cmd-6`: exited with code 6 after 1s' in digest
    assert progress[1] == 7


def test_digest_carries_refusals_after_the_review_separator() -> None:
    pending = 'Pending user confirmation for `npm publish`.\n\n---\nUser cancelled the pending command: npm publish.'
    messages = [
        user('go'),
        ai_call('c', 'run_command', {'command': 'npm publish'}),
        result('c', pending, 'run_command'),
        ai_call('d', 'run_command', {'command': 'rm'}),
        result(
            'd',
            'Not approved: the user stopped this turn while this call waited for approval, so it did not run.',
            'run_command',
        ),
        ai_call('w', 'fetch_url', {'url': 'x'}),
        # A page that says this is not a refusal.
        result('w', 'User cancelled their subscription last year.\nmore', 'fetch_url'),
    ]
    digest, _ = _digest(messages)
    assert 'run_command: User cancelled the pending command: npm publish.' in digest
    assert 'run_command: Not approved:' in digest
    assert 'subscription' not in digest


def test_digest_carries_delete_refusals_user_resets_and_reports() -> None:
    report = f'{REPORTS_ARRIVED_HEADER}\n\nSub-agent `w` finished.\nIt found the bug in parser.py.'
    messages = [
        user('go'),
        HumanMessage(content='User cancelled the delete request.', id='n1'),
        HumanMessage(content='User reset `a.py` from turn 3 to its pre-edit state', id='n2'),
        HumanMessage(content=report, id='n3'),
        ai_call('s', 'spawn_subagent', {'task': 'x'}),
        result('s', 'Sub-agent `v` finished: ' + 'r' * 2000, 'spawn_subagent'),
    ]
    digest, _ = _digest(messages)
    assert 'User cancelled the delete request.' in digest
    assert 'User reset `a.py` from turn 3 to its pre-edit state' in digest
    assert 'It found the bug in parser.py.' in digest
    assert 'Sub-agent `v` finished' in digest
    assert 'r' * 2000 not in digest


def test_digest_keeps_the_last_plan_progress_and_counts_marks() -> None:
    marks = []
    for number, (done, pending) in enumerate([('step-1', 'step-2, step-3'), ('step-1, step-2', 'step-3')]):
        body = f'Marked complete: x. Completed steps: {done}. Pending steps: {pending}.'
        marks += [ai_call(f'm{number}', 'mark_build_plan_steps_complete', {}), result(f'm{number}', body)]
    digest, progress = _digest([user('go'), *marks])
    assert 'Completed steps: step-1, step-2. Pending steps: step-3.' in digest
    assert 'Pending steps: step-2, step-3' not in digest
    assert progress[3] == 2


def test_digest_lists_tree_changes() -> None:
    digest, _ = _digest([user('go')], [('created', 'new.py'), ('deleted', 'old.py'), ('renamed', 'moved.py')])
    assert '+ new.py, - old.py, + moved.py' in digest
    many = [('created', f'f{n}.py') for n in range(30)]
    digest, _ = _digest([user('go')], many)
    assert 'f29.py' in digest
    assert 'f9.py' not in digest
    assert '10 more' in digest


def test_digest_stays_within_its_cap_and_keeps_first_and_newest() -> None:
    messages = [user('the first request', 'u0')]
    for number in range(200):
        messages += [AIMessage(content='a', id=f'a{number}'), user(f'request number {number}', f'u{number + 1}')]
        call = ai_call(f'c{number}', 'read_workspace_file', {'relative_path': f'dir/file{number}.py'})
        messages += [call, result(f'c{number}')]
    digest, progress = _digest(messages, max_chars=1500)
    assert len(digest) <= 1500
    assert 'the first request' in digest
    assert 'request number 199' in digest
    assert 'more not shown' in digest
    assert 'dir/file199.py' in digest
    # What fits is cut, what counts is not.
    assert progress[2] == 200


def test_digest_progress_counts_new_calls_of_other_tools_not_repeats() -> None:

    def fetch(call_id: str, url: str) -> list[Any]:
        return [ai_call(call_id, 'fetch_url', {'url': url}), result(call_id, 'page', 'fetch_url')]

    once = _digest([user('go'), *fetch('a', 'http://one')])[1]
    repeated = _digest([user('go'), *fetch('a', 'http://one'), *fetch('b', 'http://one')])[1]
    another = _digest([user('go'), *fetch('a', 'http://one'), *fetch('b', 'http://two')])[1]
    assert once == repeated == [0, 0, 1, 0]
    assert another == [0, 0, 2, 0]
    failed = [ai_call('c', 'fetch_url', {'url': 'http://x'}), result('c', 'Tool error: no', 'fetch_url')]
    assert _digest([user('go'), *failed])[1] == [0, 0, 0, 0]


def test_digest_read_progress_counts_lines_never_read_before() -> None:
    def read(call_id: str, first: int, last: int) -> list[Any]:
        return [
            ai_call(call_id, 'read_workspace_file', {'relative_path': 'a.py', 'start_line': first}),
            result(call_id, read_body('a.py', first, last, 100), 'read_workspace_file'),
        ]

    first_part = read('r1', 1, 40)
    assert _digest([user('go'), *first_part])[1][2] == 40
    # Another part of the file is new work.
    second_part = read('r2', 41, 80)
    digest, progress = _digest([user('go'), *first_part, *second_part])
    assert progress[2] == 80
    assert 'a.py (lines 1-80 of 100)' in digest
    # The same lines in other ranges are not: this is how a read loop looks.
    overlap = read('r3', 10, 60)
    assert _digest([user('go'), *first_part, *second_part, *overlap])[1][2] == 80
    # All of it reads as such, so a model that lost the text knows it needs no second look.
    rest = read('r4', 81, 100)
    assert 'a.py (all 100 lines)' in _digest([user('go'), *first_part, *second_part, *rest])[0]
    # Gaps stay visible.
    gap = read('r5', 90, 100)
    assert 'a.py (lines 1-40, 90-100 of 100)' in _digest([user('go'), *first_part, *gap])[0]


def test_digest_counts_the_lines_a_shortened_read_shows_not_its_header() -> None:
    """The tool budget cuts the body and keeps ``Lines: 1-220``: the lines after the cut were never seen."""
    head, shown = _shortened_read()
    assert 1 < shown < 220
    first = [
        ai_call('r1', 'read_workspace_file', {'relative_path': 'big.py'}),
        result('r1', head, 'read_workspace_file'),
    ]
    digest, progress = _digest([user('go'), *first])
    assert f'Files read: big.py (lines 1-{shown} of 900)' in digest
    assert progress == [0, 0, shown, 0]
    # Reading on as the note says is new lines, which is progress.
    rest = [
        ai_call('r2', 'read_workspace_file', {'relative_path': 'big.py', 'start_line': shown + 1}),
        result('r2', read_body('big.py', shown + 1, 220, 900), 'read_workspace_file'),
    ]
    digest, progress = _digest([user('go'), *first, *rest])
    assert 'Files read: big.py (lines 1-220 of 900)' in digest
    assert progress == [0, 0, 220, 0]
    # The same shortened read again is a read loop.
    again = [
        ai_call('r3', 'read_workspace_file', {'relative_path': 'big.py'}),
        result('r3', head, 'read_workspace_file'),
    ]
    assert _digest([user('go'), *first, *again])[1] == [0, 0, shown, 0]


def test_digest_says_all_lines_only_when_all_were_shown() -> None:
    head, shown = _shortened_read(last=220, total=220)
    first = [
        ai_call('r1', 'read_workspace_file', {'relative_path': 'big.py'}),
        result('r1', head, 'read_workspace_file'),
    ]
    assert 'all 220 lines' not in _digest([user('go'), *first])[0]
    rest = [
        ai_call('r2', 'read_workspace_file', {'relative_path': 'big.py', 'start_line': shown + 1}),
        result('r2', read_body('big.py', shown + 1, 220, 220), 'read_workspace_file'),
    ]
    assert 'big.py (all 220 lines)' in _digest([user('go'), *first, *rest])[0]


def test_digest_of_nothing_is_empty() -> None:
    assert _digest([]) == ('', [0, 0, 0, 0])


# ---------------------------------------------------------------------------
# The notes call
# ---------------------------------------------------------------------------


def test_summary_prompt_is_the_contract_text() -> None:
    assert summary_prompt('', 32768) == SUMMARY_REQUEST.format(words=327)
    assert SUMMARY_REQUEST.startswith('[Harness request.] Older messages will be removed.')
    assert 'NEXT STEP:' in SUMMARY_REQUEST and 'LEARNED:' in SUMMARY_REQUEST


def test_summary_prompt_carries_the_last_1500_reasoning_chars() -> None:
    prompt = summary_prompt('a' * 500 + 'b' * 1500, 32768)
    request = SUMMARY_REQUEST.format(words=327)
    assert prompt.startswith(request)
    assert prompt.endswith('b' * 1500)
    assert 'a' not in prompt[len(request) :].split('\n', 3)[-1]


def _continuation(provider: str, extra: dict | None = None, settings: dict | None = None) -> Any:
    view = [user('go')]
    return continuation_request(_request(extra, settings or {}), view, 'PROMPT', provider, 32768), view


def test_continuation_on_llamacpp_ends_thinking_and_caps_output() -> None:
    req, view = _continuation(
        'llamacpp', {'top_k': 40, 'chat_template_kwargs': {'x': 1}}, {'parallel_tool_calls': True}
    )
    assert req.tool_choice == 'none'
    assert req.messages[:-1] == view
    assert req.messages[-1].content == 'PROMPT'
    assert req.model_settings['max_tokens'] == 1500
    assert req.model_settings['parallel_tool_calls'] is True
    assert req.model_settings['extra_body'] == {
        'top_k': 40,
        'chat_template_kwargs': {'x': 1},
        'max_tokens': 1500,
        'reasoning_budget_tokens': 0,
    }


def test_continuation_on_lmstudio_caps_output_without_a_budget() -> None:
    req, _ = _continuation('lmstudio', {'top_k': 40})
    assert req.model_settings['max_tokens'] == 1500
    assert req.model_settings['extra_body'] == {'top_k': 40, 'max_tokens': 1500}


@pytest.mark.parametrize('provider', ['openai', 'openrouter'])
def test_continuation_on_hosted_providers_has_a_larger_cap_and_no_extra_body(provider: str) -> None:
    req, _ = _continuation(provider, {'provider': {'order': ['x']}})
    assert req.tool_choice == 'none'
    assert req.model_settings == {'max_tokens': 4000}


def test_continuation_on_anthropic_binds_a_real_none_choice() -> None:
    """A bare ``'none'`` would be a forced tool named none, and the parallel flag a field ``none`` rejects."""
    req, _ = _continuation('anthropic', None, {'parallel_tool_calls': True})
    assert req.tool_choice == {'type': 'none'}
    assert 'parallel_tool_calls' not in req.model_settings

    @tool
    def probe(path: str) -> str:
        """Probe."""
        return path

    model = ChatAnthropic(model='claude-x', api_key='k')
    bound = model.bind_tools([probe], tool_choice=req.tool_choice, **req.model_settings)
    assert bound.kwargs['tool_choice'] == {'type': 'none'}
    assert bound.kwargs['max_tokens'] == 4000


@pytest.mark.asyncio(loop_scope='function')
async def test_internal_call_hides_the_call_from_the_callback_context_only_during_it() -> None:
    from langchain_core.runnables.config import var_child_runnable_config

    seen: list[Any] = []
    sentinel = {'callbacks': 'parent'}
    token = var_child_runnable_config.set(sentinel)

    async def handler(req: Any) -> Any:
        seen.append(var_child_runnable_config.get())
        return SimpleNamespace(result=[AIMessage(content=req)])

    try:
        message = await internal_call(handler, 'request')
        assert message.content == 'request'
        assert seen == [None]
        assert var_child_runnable_config.get() is sentinel

        async def failing(req: Any) -> Any:
            raise RuntimeError(req)

        with pytest.raises(RuntimeError):
            await internal_call(failing, 'request')
        assert var_child_runnable_config.get() is sentinel
    finally:
        var_child_runnable_config.reset(token)


def test_notes_are_accepted_when_usable() -> None:
    assert accepted_notes(AIMessage(content='  NEXT STEP: go\n'), 32768) == 'NEXT STEP: go'
    assert accepted_notes(AIMessage(content=''), 32768) == ''
    assert accepted_notes(AIMessage(content='<tool_call><function=x></function></tool_call>'), 32768) == ''
    assert accepted_notes(AIMessage(content='<function=read><parameter=a>b</parameter></function>'), 32768) == ''


def test_notes_are_capped_at_a_newline() -> None:
    long = 'line of notes\n' * 1000
    notes = accepted_notes(AIMessage(content=long), 32768)
    assert len(notes) <= 4000
    assert notes.endswith('line of notes')


def test_truncated_notes_lose_their_cut_line() -> None:
    message = AIMessage(content='NEXT STEP: go\nPROGRESS: half', response_metadata={'finish_reason': 'length'})
    assert accepted_notes(message, 32768) == 'NEXT STEP: go'


def test_gemma_channels_do_not_reach_the_notes() -> None:
    message = AIMessage(content='<|channel>thought\nprivate thought<channel|>NEXT STEP: go')
    assert accepted_notes(message, 32768) == 'NEXT STEP: go'


# ---------------------------------------------------------------------------
# Overflow errors
# ---------------------------------------------------------------------------


def _bad_request(message: str, body: Any) -> Exception:
    import httpx

    response = httpx.Response(400, request=httpx.Request('POST', 'http://x'))
    return openai.BadRequestError(message, response=response, body=body)


def test_overflow_from_llama_server_body() -> None:
    body = {'code': 400, 'type': 'exceed_context_size_error', 'n_prompt_tokens': 40000, 'n_ctx': 32768, 'message': 'x'}
    assert overflow_info(_bad_request('Error code: 400', body)) == (40000, 32768)


def test_overflow_body_with_missing_numbers() -> None:
    body = {'type': 'exceed_context_size_error', 'n_prompt_tokens': 'many'}
    assert overflow_info(_bad_request('Error code: 400', body)) == (None, None)


def test_overflow_from_context_overflow_error() -> None:
    assert overflow_info(ContextOverflowError('too long')) == (None, None)


@pytest.mark.parametrize(
    ('text', 'expected'),
    [
        ('request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it', (40000, 32768)),
        ("{'type': 'exceed_context_size_error', 'n_prompt_tokens': 40000, 'n_ctx': 32768}", (40000, 32768)),
        (
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
            (9000, 8192),
        ),
        ('prompt is too long: 205000 tokens > 200000 maximum', (205000, 200000)),
        (
            'Trying to keep the first 40000 tokens when context the overflows. However, the model is loaded '
            'with context length of only 32768 tokens',
            (40000, 32768),
        ),
        ('Your input exceeds the context window of this model', (None, None)),
        ('Error: context_length_exceeded', (None, None)),
        ('input length and `max_tokens` exceed context limit: 180000 + 40000 > 200000', (None, None)),
    ],
)
def test_overflow_from_hosted_text(text: str, expected: tuple[int | None, int | None]) -> None:
    assert overflow_info(RuntimeError(text)) == expected


@pytest.mark.parametrize(
    'text', ['Connection reset by peer', 'Conversation roles must alternate', 'rate limit exceeded', 'context']
)
def test_other_errors_are_not_overflow(text: str) -> None:
    assert overflow_info(RuntimeError(text)) is None


# ---------------------------------------------------------------------------
# Tool budget
# ---------------------------------------------------------------------------


def test_tool_cap_formula() -> None:
    # 20% of the window at 3.2 chars per token, within 4000 and 120000.
    assert tool_output_cap_chars(32768, 1, 0) == int(0.2 * 32768 * 3.2)
    assert tool_output_cap_chars(4000, 1, 0) == 4000
    assert tool_output_cap_chars(1_000_000, 1, 0) == 120000
    # Room left for each of the step's calls.
    assert tool_output_cap_chars(32768, 5, 9000) == int((32768 - 4915 - 9000) * 3.2 / 5)


def test_tool_cap_never_goes_below_a_floor() -> None:
    assert tool_output_cap_chars(8000, 1, 50000) == 1000


def test_truncate_short_result_is_the_same_string() -> None:
    body = 'short'
    assert truncate_tool_result('read_workspace_file', body, 100) is body
    assert truncate_tool_result('run_command', body, 100) is body


def test_truncate_read_keeps_the_head_and_says_where_to_go_on() -> None:
    body = read_body(first=101, last=400)
    out = truncate_tool_result('read_workspace_file', body, 2000)
    assert out.startswith('File: a.py')
    assert ' 400 │ ' not in out
    last_shown = int(out.split('\n')[-2].split('│')[0])
    assert f'call again with start_line={last_shown + 1}.]' in out
    assert '[Shortened to fit the context:' in out
    # Whole lines only.
    assert out.split('\n')[-2].endswith(f'line {last_shown}')


def test_truncate_read_goes_on_from_the_first_gap() -> None:
    """The read tool's own cap left lines 28-377 out; the note must not send the model past them."""
    numbered = [f'{n:4} │ ' + 'x' * 60 for n in [*range(1, 28), *range(378, 800)]]
    body = 'File: a.py\nLines: 1-800 (of 800 in file)\n' + '\n'.join(numbered)
    out = truncate_tool_result('read_workspace_file', body, 2100)
    assert ' 378 │ ' in out
    assert 'call again with start_line=28.]' in out


def test_truncate_search_says_to_narrow_it() -> None:
    body = '\n'.join(f'[a.py line {n}] │ hit' for n in range(1000))
    out = truncate_tool_result('search_workspace', body, 1000)
    assert out.endswith('To see more, narrow the range or the query.]')


def test_truncate_other_results_keep_head_and_tail() -> None:
    body = 'HEAD' + 'x' * 10000 + 'TAIL'
    out = truncate_tool_result('run_command', body, 1000)
    assert out.startswith('HEAD') and out.endswith('TAIL')
    assert 'chars omitted' in out


# ---------------------------------------------------------------------------
# The stale edit guard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('args', [{'filename': 'a.py', 'content': 'x'}, {'relative_path': '  ', 'content': 'x'}])
def test_an_edit_with_no_path_is_left_to_the_schema_error(args: dict) -> None:
    call = {'name': 'write_workspace_file', 'id': 'e', 'args': args}
    assert stale_edit_refusal(call, [user('go'), ai_call('x', message_id='cut')], CUT) is None


def _replace(start: int, end: int, path: str = 'a.py', text: str = 'new') -> dict:
    return {
        'name': 'replace_workspace_lines',
        'id': 'e',
        'args': {'relative_path': path, 'start_line': start, 'end_line': end, 'new_content': text},
    }


def _overwrite(path: str = 'a.py', text: str = 'new') -> dict:
    return {'name': 'write_workspace_file', 'id': 'w', 'args': {'relative_path': path, 'content': text}}


def _view_with_read(path: str = 'a.py', first: int = 40, last: int = 60, gutter: bool = True) -> list[Any]:
    call = ai_call('r', 'read_workspace_file', {'relative_path': path}, 'cut')
    return [user('go'), call, result('r', read_body(path, first, last, 900, gutter), 'read_workspace_file')]


CUT = {'cut_id': 'cut', 'block': 'B'}


def test_guard_refuses_lines_with_no_read_in_view() -> None:
    assert stale_edit_refusal(_replace(40, 60), [user('go'), ai_call('x', message_id='cut')], CUT) == (
        'Tool error: `a.py` lines 40-60 are not in your context. Nothing was written. '
        'Read them with read_workspace_file, then retry.'
    )


def test_guard_ignores_reads_before_the_cut() -> None:
    old_read = _view_with_read()
    old_read[1].id = 'before'
    messages = [*old_read, ai_call('x', message_id='cut'), result('x')]
    assert stale_edit_refusal(_replace(40, 60), messages, CUT) is not None


def test_guard_ignores_elided_reads() -> None:
    messages = _view_with_read()
    assert stale_edit_refusal(_replace(40, 60), messages, CUT) is None
    assert stale_edit_refusal(_replace(40, 60), messages, {**CUT, 'elided_ids': ['t-r']}) is not None


@pytest.mark.parametrize(
    ('start', 'end', 'allowed'),
    [
        (40, 60, True),
        (50, 50, True),
        (30, 45, True),
        # Adjoining: appending at n+1 after reading up to n must work.
        (61, 61, True),
        (30, 39, True),
        (62, 62, False),
        (10, 38, False),
    ],
)
def test_guard_allows_overlapping_or_adjoining_ranges(start: int, end: int, allowed: bool) -> None:
    refusal = stale_edit_refusal(_replace(start, end), _view_with_read(), CUT)
    assert (refusal is None) is allowed


def test_guard_uses_gutter_numbers_over_the_header() -> None:
    """A read cut by the budget says 1-220 but shows less: the numbers that came back count."""
    body = read_body('a.py', 1, 220, 900)
    head = truncate_tool_result('read_workspace_file', body, 800)
    messages = [user('go'), ai_call('r', 'read_workspace_file', {}, 'cut'), result('r', head, 'read_workspace_file')]
    assert stale_edit_refusal(_replace(5, 6), messages, CUT) is None
    assert stale_edit_refusal(_replace(200, 201), messages, CUT) is not None


def test_guard_sees_gaps_in_a_read_with_head_and_tail() -> None:
    lines = '\n'.join(f'{n:>4} │ x' for n in (1, 2, 3, 500, 501))
    body = f'File: a.py\nLines: 1-501 (of 501 in file)\n\n{lines}'
    messages = [user('go'), ai_call('r', 'read_workspace_file', {}, 'cut'), result('r', body, 'read_workspace_file')]
    assert stale_edit_refusal(_replace(2, 2), messages, CUT) is None
    assert stale_edit_refusal(_replace(500, 500), messages, CUT) is None
    assert stale_edit_refusal(_replace(100, 110), messages, CUT) is not None


def test_guard_falls_back_to_the_lines_header_without_a_gutter() -> None:
    messages = _view_with_read(gutter=False)
    assert stale_edit_refusal(_replace(40, 60), messages, CUT) is None
    assert stale_edit_refusal(_replace(100, 110), messages, CUT) is not None


def test_guard_empty_range_read_does_not_count() -> None:
    body = 'File: a.py\nEncoding: utf-8\nLines: requested 900-950 (of 10 in file)\n\n[empty range]'
    messages = [user('go'), ai_call('r', 'read_workspace_file', {}, 'cut'), result('r', body, 'read_workspace_file')]
    assert stale_edit_refusal(_replace(900, 900), messages, CUT) is not None


def test_guard_lets_a_read_of_an_empty_file_count() -> None:
    """No line to show, so no range: without this, reading never clears the refusal that asks for a read."""
    body = 'File: a.py\nEncoding: utf-8\nLines: requested 1-220 (of 0 in file)\n\n[empty range]'
    messages = [user('go'), ai_call('r', 'read_workspace_file', {}, 'cut'), result('r', body, 'read_workspace_file')]
    assert stale_edit_refusal(_overwrite(), messages, CUT) is None
    assert stale_edit_refusal(_replace(1, 1), messages, CUT) is None
    # Any range: the tool's own error says how to seed the file, which no read could ever clear here.
    assert stale_edit_refusal(_replace(5, 5), messages, CUT) is None
    # Only that file.
    assert stale_edit_refusal(_overwrite('b.py'), messages, CUT) is not None


def test_guard_a_quoted_empty_file_header_does_not_count() -> None:
    quoted = 'File: a.py\nEncoding: utf-8\nLines: 1-1 (of 900 in file)\n\nLines: requested 1-220 (of 0 in file)'
    messages = [user('go'), ai_call('r', 'read_workspace_file', {}, 'cut'), result('r', quoted, 'read_workspace_file')]
    assert stale_edit_refusal(_replace(40, 40), messages, CUT) is not None


def test_guard_compares_paths_however_spelled() -> None:
    messages = _view_with_read('src/a.py')
    assert stale_edit_refusal(_replace(40, 60, './src/a.py'), messages, CUT) is None
    assert stale_edit_refusal(_replace(40, 60, 'src\\a.py'), messages, CUT) is None
    assert stale_edit_refusal(_replace(40, 60, 'other/a.py'), messages, CUT) is not None


def test_guard_lets_a_bad_range_reach_the_tools_own_error() -> None:
    messages = [user('go'), ai_call('x', message_id='cut')]
    assert stale_edit_refusal(_replace(0, 0), messages, CUT) is None
    assert stale_edit_refusal(_replace(9, 3), messages, CUT) is None
    bad = _replace(1, 2)
    bad['args']['start_line'] = 'many'
    assert stale_edit_refusal(bad, messages, CUT) is None


def test_guard_on_overwrites() -> None:
    no_read = [user('go'), ai_call('x', message_id='cut')]
    assert stale_edit_refusal(_overwrite(), no_read, CUT) == (
        'Tool error: `a.py` is not in your context. Nothing was written. Read it with read_workspace_file, then retry.'
    )
    assert stale_edit_refusal(_overwrite(), no_read, CUT, file_exists=False) is None
    assert stale_edit_refusal(_overwrite(), _view_with_read(), CUT) is None


def test_guard_allows_after_a_successful_write_in_view() -> None:
    write = ai_call('w', 'write_workspace_file', {'relative_path': 'a.py', 'content': 'x'}, 'cut')
    messages = [user('go'), write, result('w', 'Created `a.py`.', 'write_workspace_file')]
    assert stale_edit_refusal(_replace(1, 1), messages, CUT) is None
    assert stale_edit_refusal(_overwrite(), messages, CUT) is None
    failed = [user('go'), write, result('w', 'Tool error: no.', 'write_workspace_file')]
    assert stale_edit_refusal(_replace(1, 1), failed, CUT) is not None
    # With its text elided, the model no longer has what it wrote.
    assert stale_edit_refusal(_replace(1, 1), messages, {**CUT, 'elided_ids': ['cut']}) is not None


def test_guard_a_write_the_tool_node_refused_is_no_write_in_view() -> None:
    write = ai_call('w', 'write_workspace_file', {'relative_path': 'a.py'}, 'cut')
    assert stale_edit_refusal(_replace(200, 210), [user('go'), write, refused('w')], CUT) is not None
    assert stale_edit_refusal(_overwrite(), [user('go'), write, refused('w')], CUT) is not None


def test_guard_refuses_placeholders_on_every_edit() -> None:
    placeholder = '[Removed to save context: 5000 chars. This call already ran; read the file to see them.]'
    messages = _view_with_read()
    assert 'placeholder' in stale_edit_refusal(_replace(40, 60, text=placeholder), messages, CUT)
    assert 'placeholder' in stale_edit_refusal(_overwrite(text=placeholder), messages, CUT, file_exists=False)
    snippet = {
        'name': 'replace_workspace_snippet',
        'id': 's',
        'args': {'relative_path': 'a.py', 'new_snippet': placeholder},
    }
    assert 'placeholder' in stale_edit_refusal(snippet, messages, CUT)
    # A file about placeholders is not one.
    file_about_it = 'Docs mention [Removed to save context: 5 chars.] in a sentence.\n' * 20
    assert stale_edit_refusal(_replace(40, 60, text=file_about_it), messages, CUT) is None


def test_guard_ignores_snippet_edits_and_other_tools() -> None:
    no_read = [user('go'), ai_call('x', message_id='cut')]
    snippet = {'name': 'replace_workspace_snippet', 'id': 's', 'args': {'relative_path': 'a.py', 'new_snippet': 'x'}}
    assert stale_edit_refusal(snippet, no_read, CUT) is None
    assert stale_edit_refusal({'name': 'read_workspace_file', 'id': 'r', 'args': {}}, no_read, CUT) is None
