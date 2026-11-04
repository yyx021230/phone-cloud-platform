"""Build a private, disabled account-phone registry from the supplied workbook.

Reads files only; never connects to phones, services or Feishu. Full phone
numbers belong in the mode-0600 output, not stdout or Git fixtures.
"""
import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re

SHEETS = frozenset(('广州云井个人企微帐号管理', '广州云井新增企微账号',
                    '新增企微号', '广州云井经销商企微账号', '优居帐号'))
PHONE_HEADERS = ('号码1', '号码', '电话号码', '原注册号码')
DEVICE_HEADERS = ('企微登录手机编号', '企微登陆手机', '登陆手机')
PHONE = re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')


def text(value):
    if value is None:
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def device_label(value):
    value = re.sub(r'\s+', '', text(value))
    if any(word in value for word in ('原', '退出', '未找到', '未登记', '自己手机')):
        return None, None
    match = re.fullmatch(r'(?:[\u4e00-\u9fff]{1,8})?([1-9]\d{0,2})(?:(企微|微)([12])|号?(主号|分身))?', value)
    if not match:
        return None, None
    number, _, digit, label = match.groups()
    slot = 'clone' if digit == '2' or label == '分身' else 'main' if digit == '1' or label == '主号' else None
    return number, slot


def registry(sheets):
    rows = []
    for sheet_name, values in sheets:
        if sheet_name not in SHEETS:
            continue
        columns = None
        inactive_section = False
        for row_index, cells in enumerate(values, 1):
            cells = [text(v) for v in cells]
            phone_index = next((cells.index(k) for k in PHONE_HEADERS if k in cells), None)
            device_index = next((cells.index(k) for k in DEVICE_HEADERS if k in cells), None)
            if phone_index is not None and device_index is not None:
                columns = (phone_index, device_index)
                inactive_section = False
                continue
            if phone_index is not None or device_index is not None:
                # A new, unsupported table must not inherit previous indices.
                columns = None
                continue
            joined = ' '.join(cells)
            if re.search(r'以下.*(?:不方便|释放实名|退出|停用|不可用)', joined):
                inactive_section = True
            if columns is None or len(cells) <= max(columns):
                continue
            phones = PHONE.findall(cells[columns[0]])
            if not phones:
                continue
            number, slot = device_label(cells[columns[1]])
            flags = []
            if len(phones) != 1:
                flags.append('source_phone_ambiguous')
            if number is None:
                flags.append('source_device_unconfirmed')
            if inactive_section or re.search(r'已退出|不添加客户|暂不能|暂时不能|卡异常|操作频繁|涉嫌使用外挂', joined):
                flags.append('source_restriction_requires_review')
            if sheet_name == '优居帐号' and len(cells) > 2 and PHONE.search(cells[2]):
                flags.append('replacement_phone_requires_review')
            for phone in phones:
                rows.append({'accountPhone': phone, 'deviceNumber': number, 'appSlot': slot,
                             'source': {'sheet': sheet_name, 'row': row_index}, 'flags': flags})
    grouped = defaultdict(list)
    for row in rows:
        grouped[row['accountPhone']].append(row)
    accounts = []
    for phone, sources in grouped.items():
        devices = {r['deviceNumber'] for r in sources if r['deviceNumber']}
        slots = {r['appSlot'] for r in sources if r['appSlot']}
        flags = {f for r in sources for f in r['flags']}
        if len(devices) > 1:
            flags.add('phone_device_conflict')
        if len(slots) > 1:
            flags.add('phone_slot_conflict')
        for name in {r['source']['sheet'] for r in sources}:
            in_sheet = [r for r in sources if r['source']['sheet'] == name]
            if len({(r['deviceNumber'], r['appSlot']) for r in in_sheet}) > 1:
                flags.add('same_sheet_phone_binding_conflict')
        number = next(iter(devices)) if len(devices) == 1 else None
        slot = next(iter(slots)) if len(slots) == 1 else None
        if number and not slot:
            flags.add('account_slot_probe_required')
        accounts.append({'accountPhone': phone, 'deviceNumber': number, 'appSlot': slot,
                         'bindingVerified': False, 'enabled': False, 'flags': sorted(flags),
                         'sources': sources})
    physical = defaultdict(list)
    for account in accounts:
        if account['deviceNumber'] and account['appSlot']:
            physical[(account['deviceNumber'], account['appSlot'])].append(account)
    for matches in physical.values():
        if len(matches) > 1:
            for account in matches:
                account['flags'] = sorted(set(account['flags']) | {'slot_multiple_accounts'})
    return {'schemaVersion': 1, 'accounts': sorted(accounts, key=lambda r: r['accountPhone']),
            'membersDraft': [{'wecom_phone': a['accountPhone'], 'deviceNumber': a['deviceNumber'],
                              'appSlot': a['appSlot'], 'bindingVerified': False, 'enabled': False}
                             for a in accounts if a['deviceNumber'] and a['appSlot'] and not any(
                                 f in a['flags'] for f in ('phone_device_conflict', 'phone_slot_conflict',
                                                          'same_sheet_phone_binding_conflict', 'slot_multiple_accounts',
                                                          'source_phone_ambiguous'))],
            'sourceRowCount': len(rows), 'automaticEnableAllowed': False}


def read_workbook(path):
    import openpyxl
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        result = []
        for sheet in book:
            if sheet.title in SHEETS:
                # Feishu export can report A1 despite hundreds of real XML rows.
                sheet.reset_dimensions()
                result.append((sheet.title, list(sheet.iter_rows(values_only=True))))
        return result
    finally:
        book.close()


def summary(value):
    accounts = value['accounts']
    return {'sourceRows': value['sourceRowCount'], 'uniqueAccountPhones': len(accounts),
            'deviceNumbers': sorted({a['deviceNumber'] for a in accounts if a['deviceNumber']}, key=int),
            'explicitSlots': sum(a['appSlot'] is not None for a in accounts),
            'slotProbeRequired': sum('account_slot_probe_required' in a['flags'] for a in accounts),
            'issueCounts': {f: sum(f in a['flags'] for a in accounts) for f in sorted({f for a in accounts for f in a['flags']})},
            'enabled': 0, 'productionChanged': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--xlsx', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    value = registry(read_workbook(args.xlsx))
    value['sourceSha256'] = hashlib.sha256(args.xlsx.read_bytes()).hexdigest()
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
    print(json.dumps(summary(value), ensure_ascii=False))


if __name__ == '__main__':
    main()
