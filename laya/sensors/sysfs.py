"""
Laya Sensors — Linux USB & sysfs Hardware Inspector
Scans physical USB buses, maps Huawei modem endpoints, and monitors serial nodes.
"""

import os
import glob
import re

MODEM_VENDORS = {
    "12d1": "Huawei",
    "19d2": "ZTE",
    "1e0e": "SIMCom",
    "05c6": "Qualcomm",
    "2c7c": "Quectel"
}

def scan_usb_modems():
    """
    Scans /sys/bus/usb/devices/ and returns list of physical GSM modems with their ttyUSB interfaces.
    """
    modems = []
    base_dir = "/sys/bus/usb/devices"
    
    for dev_path in glob.glob(os.path.join(base_dir, "*")):
        dev_name = os.path.basename(dev_path)
        vendor_file = os.path.join(dev_path, "idVendor")
        product_file = os.path.join(dev_path, "idProduct")
        
        if not os.path.isfile(vendor_file) or not os.path.isfile(product_file):
            continue
            
        try:
            with open(vendor_file, "r") as f:
                vendor_id = f.read().strip().lower()
            with open(product_file, "r") as f:
                product_id = f.read().strip().lower()
        except Exception:
            continue
            
        if vendor_id not in MODEM_VENDORS:
            continue

        manufacturer = MODEM_VENDORS.get(vendor_id, "Unknown")
        
        # Read product name if available
        product_name = ""
        prod_desc_file = os.path.join(dev_path, "product")
        if os.path.isfile(prod_desc_file):
            try:
                with open(prod_desc_file, "r") as f:
                    product_name = f.read().strip()
            except Exception:
                pass

        # Discover all ttyUSB endpoints for this USB device
        tty_ports = []
        for match in glob.glob(os.path.join(dev_path, "*:*/ttyUSB*")) + glob.glob(os.path.join(dev_path, "*:*/tty/ttyUSB*")):
            port_name = os.path.basename(match)
            dev_node = f"/dev/{port_name}"
            is_present = os.path.exists(dev_node)
            tty_ports.append({
                "port": port_name,
                "node": dev_node,
                "present": is_present,
                "sysfs_subpath": match
            })
            
        # Sort tty ports numerically (ttyUSB0, ttyUSB1, ttyUSB2)
        def sort_key(p):
            m = re.search(r'\d+', p["port"])
            return int(m.group(0)) if m else 0
        tty_ports.sort(key=sort_key)

        modems.append({
            "sysfs_name": dev_name,
            "sysfs_path": dev_path,
            "vendor_id": vendor_id,
            "product_id": product_id,
            "manufacturer": manufacturer,
            "product_name": product_name,
            "ports": tty_ports,
            "is_alive": len(tty_ports) > 0 and all(p["present"] for p in tty_ports)
        })

    return modems

def check_serial_port_health(dev_node):
    """
    Checks if a /dev/ttyUSBx device is healthy, exists, and is a character device.
    """
    if not os.path.exists(dev_node):
        return False, "Device node does not exist"
    try:
        st = os.stat(dev_node)
        import stat
        if not stat.S_ISCHR(st.st_mode):
            return False, "Device node is not a character device"
        return True, "OK"
    except Exception as e:
        return False, str(e)

def find_modem_sysfs_for_port(tty_name):
    """
    Given 'ttyUSB1' or '/dev/ttyUSB1', finds the parent USB device sysfs path (e.g. '1-2').
    """
    clean_name = os.path.basename(tty_name)
    modems = scan_usb_modems()
    for m in modems:
        for p in m["ports"]:
            if p["port"] == clean_name:
                return m["sysfs_name"], m["sysfs_path"]
    return None, None

def get_dongle_configured_ports_from_conf(dongle_id, conf_path="/etc/asterisk/dongle.conf"):
    """
    Strict isolation helper: Parses /etc/asterisk/dongle.conf for a specific [dongleX]
    and returns {'audio': str, 'data': str} without touching other sections.
    """
    ports = {"audio": None, "data": None}
    if not os.path.isfile(conf_path):
        return ports
    target_sec = dongle_id.lower().strip()
    current_sec = None
    try:
        with open(conf_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    current_sec = line[1:-1].strip().lower()
                    continue
                if current_sec == target_sec and "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip().lower()
                    val = v.strip().split(";")[0].strip()
                    if k in ("audio", "data"):
                        ports[k] = val
    except Exception:
        pass
    return ports

def find_modem_sysfs_for_dongle(dongle_id, audio_port=None, data_port=None):
    """
    Strict isolation helper: Identifies physical USB sysfs bus path ONLY for the ports
    assigned to this specific dongle. NEVER falls back to other dongles' ports!
    Returns (sysfs_name, sysfs_path) or (None, None).
    """
    if not audio_port or not data_port:
        conf_ports = get_dongle_configured_ports_from_conf(dongle_id)
        audio_port = audio_port or conf_ports.get("audio")
        data_port = data_port or conf_ports.get("data")

    candidate_ports = []
    if audio_port:
        candidate_ports.append(os.path.basename(audio_port))
    if data_port:
        candidate_ports.append(os.path.basename(data_port))

    if not candidate_ports:
        return None, None

    modems = scan_usb_modems()
    for m in modems:
        modem_ports = {p["port"] for p in m.get("ports", [])}
        for cand in candidate_ports:
            if cand in modem_ports:
                return m["sysfs_name"], m["sysfs_path"]
    return None, None

def get_dongles_sharing_sysfs_device(sysfs_name, conf_path="/etc/asterisk/dongle.conf"):
    """
    Strict isolation helper: Scans /etc/asterisk/dongle.conf to identify ALL dongles
    whose audio/data ports map to the given physical USB sysfs device.
    Used to ensure that no shared dongle on this physical USB hub port is in a live call.
    """
    shared_dongles = []
    if not os.path.isfile(conf_path):
        return shared_dongles

    modems = scan_usb_modems()
    target_modem = next((m for m in modems if m["sysfs_name"] == sysfs_name), None)
    if not target_modem:
        return shared_dongles

    modem_ports = {p["port"] for p in target_modem.get("ports", [])}

    current_sec = None
    try:
        with open(conf_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    current_sec = line[1:-1].strip().lower()
                    continue
                if current_sec and current_sec.startswith("dongle") and "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip().lower()
                    val = os.path.basename(v.strip().split(";")[0].strip())
                    if k in ("audio", "data") and val in modem_ports:
                        if current_sec not in shared_dongles:
                            shared_dongles.append(current_sec)
    except Exception:
        pass
    return shared_dongles
