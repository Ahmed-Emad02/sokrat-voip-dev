"""Minimal read-only AT probe for Huawei-style dongle data ports.

The probe is intentionally conservative: it sends only identification and SIM
status commands.  It never enables radio, changes CFUN, or writes SMS.
"""
import os
import re
import select
import termios
import time


class AtResult(object):
    def __init__(self, ok, cpin="", cimi="", imei="", model="",
                 manufacturer="", error=""):
        # type: (bool, str, str, str, str, str, str) -> None
        self.ok = ok
        self.cpin = cpin
        self.cimi = cimi
        self.imei = imei
        self.model = model
        self.manufacturer = manufacturer
        self.error = error

    def __repr__(self):
        return "AtResult(ok=%r, cpin=%r, cimi=%r, error=%r)" % (
            self.ok, self.cpin, self.cimi, self.error)


class SerialProbe(object):
    def __init__(self, baud=115200, timeout=1.5):
        # type: (int, float) -> None
        self.baud = baud
        self.timeout = timeout

    def _open(self, tty):
        # type: (str) -> int
        fd = os.open(tty, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(fd)
        attrs[0] = 0
        attrs[1] = 0
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[3] = 0
        speed = getattr(termios, "B%d" % self.baud)
        attrs[4] = speed
        attrs[5] = speed
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        try:
            termios.tcflush(fd, termios.TCIOFLUSH)
        except termios.error:
            pass
        return fd

    @staticmethod
    def _read(fd, seconds):
        # type: (int, float) -> str
        out = b""
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        return out.decode("utf-8", "replace").replace("\r", "")

    def _cmd(self, fd, command, seconds=None):
        # type: (int, str, float) -> str
        try:
            os.write(fd, (command + "\r").encode())
        except OSError as exc:
            return "<write error: %s>" % exc
        return self._read(fd, seconds if seconds is not None else self.timeout)

    def identify(self, tty):
        # type: (str) -> AtResult
        try:
            fd = self._open(tty)
        except (OSError, termios.error) as exc:
            return AtResult(False, error="open failed: %s" % exc)
        try:
            first = self._cmd(fd, "AT", 0.8)
            if "OK" not in first.upper():
                try:
                    speed = getattr(termios, "B9600")
                    attrs = termios.tcgetattr(fd)
                    attrs[4] = speed
                    attrs[5] = speed
                    termios.tcsetattr(fd, termios.TCSANOW, attrs)
                    termios.tcflush(fd, termios.TCIFLUSH)
                except (OSError, termios.error):
                    pass
                first = self._cmd(fd, "AT", 0.8)
            if "OK" not in first.upper():
                return AtResult(False, error="no AT response")
            manufacturer = self._cmd(fd, "AT+CGMI")
            model = self._cmd(fd, "AT+CGMM")
            imei_raw = self._cmd(fd, "AT+CGSN")
            cpin_raw = self._cmd(fd, "AT+CPIN?")
            cimi_raw = self._cmd(fd, "AT+CIMI")
            cpin = _first_match(cpin_raw, r"\+CPIN:\s*([^\r\n]+)")
            cimi = _first_match(cimi_raw, r"^([0-9]{5,20})\s*$")
            imei = _first_match(imei_raw, r"^([0-9]{14,17})\s*$")
            return AtResult(
                ok=bool(cpin or cimi),
                cpin=cpin,
                cimi=cimi,
                imei=imei,
                model=_first_line(model),
                manufacturer=_first_line(manufacturer),
                error="" if (cpin or cimi) else "CPIN/CIMI unavailable",
            )
        except (OSError, termios.error) as exc:
            return AtResult(False, error="probe failed: %s" % exc)
        finally:
            try:
                os.close(fd)
            except OSError:
                pass


def _first_match(text, pattern):
    # type: (str, str) -> str
    match = re.search(pattern, text, re.MULTILINE)
    return match.group(1).strip() if match else ""


def _first_line(text):
    # type: (str) -> str
    for line in text.splitlines():
        line = line.strip()
        if line and line.upper() != "OK":
            return line
    return ""
