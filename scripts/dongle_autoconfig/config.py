"""Line-preserving dongle.conf editor.

The generator must not rewrite the whole file: operators keep modulator
settings, comments, and per-device knobs in dongle.conf.  This editor only
touches the audio= and data= keys of managed sections.
"""
import copy
import re
from pathlib import Path


SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*$")


class Section(object):
    def __init__(self, name, start, end):
        # type: (str, int, int) -> None
        self.name = name
        self.start = start
        self.end = end


class DongleConfig(object):
    def __init__(self, lines=None):
        # type: (Optional[list]) -> None
        self.lines = list(lines or [])

    @classmethod
    def from_text(cls, text):
        # type: (str) -> DongleConfig
        return cls(text.splitlines())

    @classmethod
    def from_path(cls, path):
        # type: (Path) -> DongleConfig
        return cls.from_text(Path(path).read_text(encoding="utf-8"))

    def copy(self):
        # type: () -> DongleConfig
        return DongleConfig(copy.deepcopy(self.lines))

    def sections(self):
        # type: () -> list
        result = []
        current_name = None
        current_start = 0
        for index, line in enumerate(self.lines):
            match = SECTION_RE.match(line)
            if match:
                if current_name is not None:
                    result.append(Section(current_name, current_start, index))
                current_name = match.group(1).strip()
                current_start = index
        if current_name is not None:
            result.append(Section(current_name, current_start, len(self.lines)))
        return result

    def section(self, name):
        # type: (str) -> Optional[Section]
        for item in self.sections():
            if item.name == name:
                return item
        return None

    def ensure_section(self, name):
        # type: (str) -> Section
        existing = self.section(name)
        if existing:
            return existing
        if self.lines and self.lines[-1].strip():
            self.lines.append("")
        self.lines.append("[%s]" % name)
        return self.section(name)

    def get(self, section, key, default=""):
        # type: (str, str, str) -> str
        sect = self.section(section)
        if not sect:
            return default
        pattern = re.compile(r"^\s*%s\s*=\s*(.*?)\s*(?:;.*)?$" % re.escape(key))
        for line in self.lines[sect.start + 1:sect.end]:
            match = pattern.match(line)
            if match:
                return match.group(1).strip()
        return default

    def set_key(self, section, key, value):
        # type: (str, str, str) -> None
        sect = self.ensure_section(section)
        pattern = re.compile(r"^(\s*%s\s*=\s*)([^;]*?)(\s*;.*)?$" % re.escape(key))
        matches = []
        for index in range(sect.start + 1, sect.end):
            if pattern.match(self.lines[index]):
                matches.append(index)
        if matches:
            first = matches[0]
            match = pattern.match(self.lines[first])
            suffix = match.group(3) or ""
            self.lines[first] = ("%s%s%s" % (match.group(1), value, suffix)).rstrip()
            for duplicate in reversed(matches[1:]):
                del self.lines[duplicate]
            return
        self.lines.insert(sect.start + 1, "%s=%s" % (key, value))

    def set_paths(self, section, audio, data):
        # type: (str, str, str) -> None
        self.set_key(section, "audio", audio)
        self.set_key(section, "data", data)

    def remove_section(self, name):
        # type: (str) -> bool
        sect = self.section(name)
        if not sect:
            return False
        del self.lines[sect.start:sect.end]
        return True

    def render(self):
        # type: () -> str
        while self.lines and not self.lines[-1].strip():
            self.lines.pop()
        return "\n".join(self.lines) + "\n"
