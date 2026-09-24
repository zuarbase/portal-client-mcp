#!/usr/bin/env python3
"""Submit Claude's review to a pull request and gate the check on it.

Subcommands:
  submit REVIEW_JSON  Post the findings Claude wrote as one pull request
                      review, then record which findings block in GATE_FILE.
                      Exits non-zero only when nothing could be posted.
  gate                Exit 0 when the pull request may merge: the override
                      label is present, or the review for the current
                      commit completed without blocking findings. Exit 1
                      otherwise.

Environment:
  GH_TOKEN             token the gh CLI uses to call the GitHub API
  REPO                 owner/name
  PR_NUMBER            pull request number
  HEAD_SHA             commit the review applies to
  ACTOR                user who triggered the run (named when a review
                       is dismissed)
  OVERRIDE_LABEL       label that releases the block
                       (default: review-accepted)
  BLOCKING_SEVERITIES  comma-separated severities that can block
                       (default: high)
  BLOCKING_CATEGORIES  comma-separated categories that can block
                       (default: correctness,security)
  GATE_FILE            where submit records its result for gate
                       (default: claude-gate.json)

REVIEW_JSON has this shape:
  {"body": "summary markdown",
   "findings": [{"path": "src/a.py", "line": 12, "severity": "high",
                 "category": "correctness", "body": "markdown"}]}

A finding blocks when its severity and category are both in the blocking
sets. Blocking findings without the override label make the review
"changes requested" and the gate fail. With the label, the review is a
comment and the gate passes. No blocking findings: the review is an
approval, advisory comments attached, and the gate passes.

Every review body carries a hidden marker
  <!-- claude-review status=blocking|clear|incomplete count=N -->
so a later gate run (a label change) can read the result back from
GitHub.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from typing import Any


BOT_LOGIN = "github-actions[bot]"
MAX_FINDINGS = 20
INVALID_FILE_PREVIEW = 4000
SEVERITY_ALIASES = {
    "critical": "high",
    "blocker": "high",
    "high": "high",
    "medium": "medium",
    "moderate": "medium",
    "low": "low",
    "minor": "low",
    "info": "low",
    "nit": "low",
}
CATEGORIES = {
    "correctness",
    "security",
    "performance",
    "tests",
    "style",
    "structure",
    "naming",
    "duplication",
    "docs",
}
MARKER_RE = re.compile(
    r"<!-- claude-review status=(\w+)(?: count=(\d+))? -->"
)
GH = shutil.which("gh") or "gh"

Finding = dict[str, Any]
GateState = dict[str, Any]


class Settings:
    def __init__(self, environ: Mapping[str, str]) -> None:
        self.repo = environ["REPO"]
        self.pr_number = environ["PR_NUMBER"]
        self.head_sha = environ.get("HEAD_SHA", "")
        self.actor = environ.get("ACTOR", "")
        self.label = environ.get("OVERRIDE_LABEL") or "review-accepted"
        self.severities = _csv_set(
            environ.get("BLOCKING_SEVERITIES") or "high"
        )
        self.categories = _csv_set(
            environ.get("BLOCKING_CATEGORIES") or "correctness,security"
        )
        self.gate_file = environ.get("GATE_FILE") or "claude-gate.json"


def _csv_set(text: str) -> set[str]:
    return {item.strip().lower() for item in text.split(",") if item.strip()}


def log(message: str) -> None:
    sys.stdout.write(f"{message}\n")


# --- GitHub API -----------------------------------------------------------


def gh_api(
    path: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    paginate: bool = False,
) -> tuple[bool, Any, str]:
    """Call the GitHub API through gh. Returns (ok, parsed_body, stderr)."""
    command = [GH, "api", path, "--method", method]
    if paginate:
        command.append("--paginate")
    payload_path = None
    if payload is not None:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as handle:
            json.dump(payload, handle)
            payload_path = handle.name
        command += ["--input", payload_path]
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            command, capture_output=True, text=True, check=False
        )
    finally:
        if payload_path:
            os.unlink(payload_path)
    if result.returncode != 0:
        return False, None, result.stderr.strip()
    return True, _parse_concatenated_json(result.stdout), ""


def _parse_concatenated_json(text: str) -> Any:
    """Parse one JSON document, or the several --paginate concatenates."""
    decoder = json.JSONDecoder()
    documents: list[Any] = []
    index = 0
    while True:
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        value, index = decoder.raw_decode(text, index)
        documents.append(value)
    if len(documents) == 1:
        return documents[0]
    flattened: list[Any] = []
    for document in documents:
        flattened.extend(
            document if isinstance(document, list) else [document]
        )
    return flattened


def pr_labels(settings: Settings) -> set[str]:
    ok, body, error = gh_api(
        f"repos/{settings.repo}/pulls/{settings.pr_number}"
    )
    if not ok:
        log(f"::warning::Could not read pull request labels: {error}")
        return set()
    names = (label.get("name") for label in body.get("labels", []))
    return {name for name in names if isinstance(name, str)}


def bot_reviews(settings: Settings) -> list[dict[str, Any]]:
    """The bot's reviews on the pull request, oldest first."""
    ok, body, error = gh_api(
        f"repos/{settings.repo}/pulls/{settings.pr_number}/reviews",
        paginate=True,
    )
    if not ok:
        log(f"::warning::Could not list reviews: {error}")
        return []
    reviews = body if isinstance(body, list) else []
    mine = [
        review
        for review in reviews
        if (review.get("user") or {}).get("login") == BOT_LOGIN
    ]
    return sorted(mine, key=lambda review: review.get("id", 0))


def post_review(
    settings: Settings, payload: dict[str, Any]
) -> tuple[bool, Any, str]:
    return gh_api(
        f"repos/{settings.repo}/pulls/{settings.pr_number}/reviews",
        method="POST",
        payload=payload,
    )


# --- Review construction --------------------------------------------------


def read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def parse_review(text: str) -> tuple[dict[str, Any] | None, str | None]:
    """Return (data, None) on success or (None, reason) when unusable."""
    try:
        data = json.loads(text, strict=False)
    except json.JSONDecodeError as exc:
        return None, f"the review file is not valid JSON ({exc})"
    if not isinstance(data, dict):
        return None, "the review file is not a JSON object"
    return data, None


def normalize_findings(data: dict[str, Any]) -> list[Finding]:
    """Coerce the model's findings into validated, classified entries."""
    findings: list[Finding] = []
    for item in data.get("findings") or []:
        if not isinstance(item, dict):
            continue
        try:
            line = int(item.get("line") or 0)
        except (TypeError, ValueError):
            continue
        path = item.get("path")
        text = item.get("body")
        if not path or line < 1 or not text:
            continue
        severity = SEVERITY_ALIASES.get(
            str(item.get("severity") or "").strip().lower(), "low"
        )
        category = str(item.get("category") or "").strip().lower()
        if category not in CATEGORIES:
            category = "other"
        findings.append(
            {
                "path": str(path),
                "line": line,
                "severity": severity,
                "category": category,
                "body": str(text).strip(),
            }
        )
    return findings[:MAX_FINDINGS]


def blocks(finding: Finding, settings: Settings) -> bool:
    return (
        finding["severity"] in settings.severities
        and finding["category"] in settings.categories
    )


def marker(status: str, count: int = 0) -> str:
    return f"<!-- claude-review status={status} count={count} -->"


def status_line(
    blocking_count: int,
    advisory_count: int,
    label_present: bool,
    settings: Settings,
) -> str:
    if blocking_count and label_present:
        return (
            f"{blocking_count} blocking finding(s), released by the "
            f"`{settings.label}` label. The check passes."
        )
    if blocking_count:
        return (
            f"{blocking_count} blocking finding(s). The check fails until "
            f"they are fixed or the `{settings.label}` label is added."
        )
    if advisory_count:
        return (
            "No blocking findings. "
            f"{advisory_count} advisory finding(s) attached."
        )
    return "No blocking findings."


def comment_for(finding: Finding, blocking: bool) -> dict[str, Any]:
    tag = (
        f"**Severity: {finding['severity']}. "
        f"Category: {finding['category']}."
    )
    tag += " Blocking.**" if blocking else "**"
    return {
        "path": finding["path"],
        "line": finding["line"],
        "side": "RIGHT",
        "body": f"{tag}\n\n{finding['body']}",
    }


def build_review(
    summary: str,
    findings: list[Finding],
    settings: Settings,
    label_present: bool,
) -> tuple[str, str, list[dict[str, Any]], list[Finding]]:
    """Return (event, body, comments, blocking_findings)."""
    blocking = [f for f in findings if blocks(f, settings)]
    if blocking and label_present:
        event = "COMMENT"
    elif blocking:
        event = "REQUEST_CHANGES"
    else:
        event = "APPROVE"
    status = "blocking" if blocking else "clear"
    parts = [
        status_line(
            len(blocking),
            len(findings) - len(blocking),
            label_present,
            settings,
        ),
        summary,
        marker(status, len(blocking)),
    ]
    body = "\n\n".join(part for part in parts if part)
    comments = [comment_for(f, blocks(f, settings)) for f in findings]
    return event, body, comments, blocking


def fold(body: str, comments: list[dict[str, Any]]) -> str:
    """Append inline comments to the summary when GitHub rejects them."""
    lines = [
        body,
        "",
        "Inline notes (GitHub could not attach them to diff lines):",
        "",
    ]
    for comment in comments:
        text = "\n  ".join(comment["body"].splitlines())
        lines.append(f"- `{comment['path']}:{comment['line']}` {text}")
    return "\n".join(lines)


# --- Gate state -----------------------------------------------------------


def write_gate_file(settings: Settings, state: GateState) -> None:
    with open(settings.gate_file, "w", encoding="utf-8") as handle:
        json.dump(state, handle)


def read_gate_file(settings: Settings) -> GateState | None:
    try:
        with open(settings.gate_file, encoding="utf-8") as handle:
            state = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return state if isinstance(state, dict) else None


def read_gate_from_reviews(settings: Settings) -> GateState | None:
    """Recover the latest marker the bot left on the current commit."""
    state: GateState | None = None
    for review in bot_reviews(settings):
        if review.get("commit_id") != settings.head_sha:
            continue
        match = MARKER_RE.search(review.get("body") or "")
        if match:
            state = {
                "status": match.group(1),
                "count": int(match.group(2) or 0),
                "blocking": [],
            }
    return state


def dismiss_changes_requested(settings: Settings) -> bool:
    """Dismiss the bot's latest review if it requests changes."""
    reviews = bot_reviews(settings)
    if not reviews or reviews[-1].get("state") != "CHANGES_REQUESTED":
        return False
    review_id = reviews[-1]["id"]
    who = f" added by @{settings.actor}" if settings.actor else ""
    ok, _, error = gh_api(
        f"repos/{settings.repo}/pulls/{settings.pr_number}"
        f"/reviews/{review_id}/dismissals",
        method="PUT",
        payload={"message": f"Released by the `{settings.label}` label{who}."},
    )
    if not ok:
        log(
            "::warning::Could not dismiss the changes-requested review: "
            f"{error}"
        )
        return False
    return True


# --- Subcommands ----------------------------------------------------------


def submit_incomplete(settings: Settings, error: str, text: str | None) -> int:
    """Post a notice that no usable review exists and record it."""
    body = (
        f"Automated review did not complete: {error}. "
        f"See the workflow run for details.\n\n{marker('incomplete')}"
    )
    ok, _, post_error = post_review(
        settings, {"event": "COMMENT", "body": body}
    )
    write_gate_file(
        settings, {"status": "incomplete", "count": 0, "blocking": []}
    )
    if text:
        log("::group::Contents of the unusable review file")
        log(text[:INVALID_FILE_PREVIEW])
        log("::endgroup::")
    if not ok:
        log(f"::error::Could not post the failure notice: {post_error}")
        return 1
    log(f"::warning::{error}")
    return 0


def submit(settings: Settings, review_path: str) -> int:
    label_present = settings.label in pr_labels(settings)
    text = read_text(review_path)
    if text is None:
        return submit_incomplete(
            settings, "no review file was written", None
        )
    data, error = parse_review(text)
    if data is None:
        return submit_incomplete(settings, error or "unusable file", text)

    findings = normalize_findings(data)
    summary = str(data.get("body") or "").strip()
    event, body, comments, blocking = build_review(
        summary, findings, settings, label_present
    )
    payload: dict[str, Any] = {"event": event, "body": body}
    if comments:
        payload["comments"] = comments
    attached = len(comments)

    ok, _, error = post_review(settings, payload)
    if not ok and comments:
        log(
            "::warning::Submitting with inline comments failed "
            f"({error}); retrying with the notes folded into the summary"
        )
        ok, _, error = post_review(
            settings, {"event": event, "body": fold(body, comments)}
        )
        attached = 0
    if not ok:
        log(f"::error::Could not submit the review: {error}")
        return 1

    write_gate_file(
        settings,
        {
            "status": "blocking" if blocking else "clear",
            "count": len(blocking),
            "blocking": [
                {
                    key: finding[key]
                    for key in ("path", "line", "severity", "category")
                }
                for finding in blocking
            ],
        },
    )
    log(
        f"Submitted {event} review: {len(findings)} finding(s), "
        f"{len(blocking)} blocking, {attached} attached inline."
    )
    return 0


def gate(settings: Settings) -> int:
    if settings.label in pr_labels(settings):
        dismissed = dismiss_changes_requested(settings)
        note = f"The `{settings.label}` label is present; the check passes."
        if dismissed:
            note += " Dismissed the earlier changes-requested review."
        log(f"::notice::{note}")
        return 0

    state = read_gate_file(settings) or read_gate_from_reviews(settings)
    short_sha = settings.head_sha[:7] or "the current commit"
    escape = f"or add the `{settings.label}` label to merge anyway"
    if state is None:
        log(
            f"::error::No completed review found for {short_sha}. "
            f"Re-run the workflow, {escape}."
        )
        return 1
    if state.get("status") == "incomplete":
        log(
            f"::error::The review did not complete for {short_sha}. "
            f"Re-run the workflow, {escape}."
        )
        return 1
    if state.get("status") == "blocking":
        count = state.get("count", 0)
        log(
            f"::error::{count} blocking finding(s) on {short_sha}. "
            f"Fix them, {escape}."
        )
        for finding in state.get("blocking", []):
            log(
                f"  {finding['path']}:{finding['line']} "
                f"({finding['severity']} {finding['category']})"
            )
        return 1
    log("No blocking findings; the check passes.")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "submit":
        return submit(Settings(os.environ), argv[2])
    if len(argv) == 2 and argv[1] == "gate":
        return gate(Settings(os.environ))
    sys.stderr.write(
        "usage: claude_review.py submit REVIEW_JSON | claude_review.py gate\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
