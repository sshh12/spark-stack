from pydantic import BaseModel
from typing import List
import re
import asyncio

from sandbox.sandbox import DevSandbox
from agents.prompts import chat_complete


class FileChange(BaseModel):
    path: str
    diff: str
    content: str


_CODE_BLOCK_PATTERNS = [
    r"```[\w.]+\n[#/]+ (\S+)\n([\s\S]+?)```",  # Python-style comments (#)
    r"```[\w.]+\n[/*]+ (\S+) \*/\n([\s\S]+?)```",  # C-style comments (/* */)
    r"```[\w.]+\n<!-- (\S+) -->\n([\s\S]+?)```",  # HTML-style comments <!-- -->
]

_DIFF_TIPS = {
    r"<Link[^>]*>[\S\s]*?<a[^>]*>": "NEVER put a <a> in a <Link> tag (Link already uses a <a> tag)",
}


async def _apply_smart_diff(original_content: str, diff: str, tips: str) -> str:
    return await chat_complete(
        "You are a senior software engineer that applies code changes to a file. Given the original content, the diff, and the tips/adjustments, apply the changes to the content. Some code might need to be fixed based on the adjustments. Respond only with the updated content (no code blocks or other formatting).",
        f"<original-content>\n{original_content}\n</original-content>\n\n<diff>\n{diff}\n</diff>\n\n<adjustments>\n{tips}\n</adjustments>",
    )


async def parse_file_changes(sandbox: DevSandbox, content: str) -> List[FileChange]:
    changes = []

    for pattern in _CODE_BLOCK_PATTERNS:
        matches = re.finditer(pattern, content)
        for match in matches:
            file_path = match.group(1)
            diff = match.group(2).strip()
            changes.append(FileChange(path=file_path, diff=diff, content=diff))

    async def _render_diff(change: FileChange) -> FileChange:
        tips = []
        for pattern, tip in _DIFF_TIPS.items():
            if pattern in change.diff:
                tips.append(tip)
        if "existing code" not in change.diff and len(tips) == 0:
            return change
        original_content = await sandbox.read_file_contents(change.path)
        new_content = await _apply_smart_diff(
            original_content, change.diff, "\n".join([f" - {t}" for t in tips])
        )
        print(f"Applying smart diff to {change.path}")
        return FileChange(
            path=change.path,
            diff=change.diff,
            content=new_content,
        )

    changes = await asyncio.gather(*[_render_diff(change) for change in changes])

    return changes


def remove_file_changes(content: str) -> str:
    for pattern in _CODE_BLOCK_PATTERNS:
        content = re.sub(pattern, "", content)
    return content
