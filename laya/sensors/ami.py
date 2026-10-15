"""
Laya Sensors — Asterisk Manager Interface (AMI) Client
Lightweight pure-python socket connection to Asterisk Manager.
"""

import socket
import re
import time
from laya.config import AMI_HOST, AMI_PORT, AMI_USER, AMI_PASS

class AmiClient:
    def __init__(self, host=AMI_HOST, port=AMI_PORT, user=AMI_USER, password=AMI_PASS, timeout=4.0):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.timeout = timeout
        self.sock = None

    def connect(self):
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(self.timeout)
            self.sock.connect((self.host, self.port))
            # Read banner
            _ = self.sock.recv(1024)
            # Send login
            login_cmd = f"Action: Login\r\nUsername: {self.user}\r\nSecret: {self.password}\r\n\r\n"
            self.sock.sendall(login_cmd.encode("utf-8"))
            resp = self._read_response()
            if "Response: Success" in resp:
                return True
            return False
        except Exception as e:
            self.close()
            return False

    def close(self):
        if self.sock:
            try:
                self.sock.sendall(b"Action: Logoff\r\n\r\n")
            except Exception:
                pass
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def _read_response(self, max_bytes=8192):
        if not self.sock:
            return ""
        data = ""
        start = time.time()
        while time.time() - start < self.timeout:
            try:
                chunk = self.sock.recv(4096).decode("utf-8", errors="ignore")
                if not chunk:
                    break
                data += chunk
                if "\r\n\r\n" in data and ("Response:" in data or "Event:" in data):
                    break
            except socket.timeout:
                break
            except Exception:
                break
        return data

    def send_action(self, action_dict):
        """
        Sends an action dictionary and reads the response.
        Example: {'Action': 'Hangup', 'Channel': 'Dongle/dongle0-01'}
        """
        if not self.sock:
            if not self.connect():
                return None
        packet = ""
        for k, v in action_dict.items():
            packet += f"{k}: {v}\r\n"
        packet += "\r\n"
        try:
            self.sock.sendall(packet.encode("utf-8"))
            return self._read_response()
        except Exception:
            self.close()
            return None

def check_ami_alive():
    """
    Checks if Asterisk AMI is responsive.
    """
    client = AmiClient()
    connected = client.connect()
    client.close()
    return connected
