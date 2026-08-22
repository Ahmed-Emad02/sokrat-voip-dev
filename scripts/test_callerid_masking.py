#!/usr/bin/env python3
import subprocess

def test_masking_logic(cid_num, cid_name, dexten, unmask_db=False):
    # Rule 1: Internal ext length <= 4
    if len(cid_num) <= 4:
        return cid_num, cid_name, "Bypassed (Internal <= 4 digits)"
    
    # Rule 2: Anonymous / unknown
    if cid_num in ["", "anonymous", "unknown", "s", "unavailable", "restricted"]:
        return cid_num, cid_name, "Bypassed (Anonymous/Special)"
    
    # Rule 3: Length < 6
    if len(cid_num) < 6:
        return cid_num, cid_name, "Bypassed (Too short)"
    
    # Rule 4: Whitelisted destination
    if unmask_db:
        return cid_num, cid_name, "Bypassed (Whitelisted Extension)"
    
    # Rules 5-7: Masking
    prefix = cid_num[:3]
    suffix = cid_num[-2:]
    masked_num = f"{prefix}*********{suffix}"
    masked_name = f"{cid_name} [{masked_num}]" if cid_name and cid_name != cid_num else masked_num
    return masked_num, masked_name, "Masked"

if __name__ == "__main__":
    cases = [
        ("101", "Ahmed", "102", False, "101"),
        ("1001", "Mazen", "1002", False, "1001"),
        ("01012345623", "01012345623", "101", False, "010*********23"),
        ("01234567890", "John Doe", "102", False, "012*********90"),
        ("01012345623", "VIP Customer", "100", True, "01012345623"),
        ("anonymous", "", "101", False, "anonymous"),
    ]

    print("=== Caller ID Masking Test Matrix ===")
    all_ok = True
    for cid_num, cid_name, dexten, unmask, expected_num in cases:
        out_num, out_name, reason = test_masking_logic(cid_num, cid_name, dexten, unmask)
        passed = (out_num == expected_num)
        print(f"[{'PASS' if passed else 'FAIL'}] In: '{cid_num}' (Ext: {dexten}, Unmask: {unmask}) -> Display Num: '{out_num}', Name: '{out_name}' ({reason})")
        if not passed:
            all_ok = False

    if all_ok:
        print("\nAll 6 Caller ID Masking verification scenarios PASSED cleanly!")
    else:
        print("\nSome scenarios failed!")
