"""Proposed one CLOCK-only supplement; requires a separate concrete review.

Does not re-run metadata or overwrite the original unknown attempt.
"""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from collect_reviewed import BASE, ROOT, HERE, APPROVED, bounded

ALLOWED = {'scope', 'authoritySupported', 'nativeExecutionPermitted', 'physicalCleanupVerified',
           'pid', 'sampleLimit', 'executionContext', 'status', 'windowsVersion', 'pointerBits',
           'ownCreationFileTime100ns', 'qpcFrequency', 'adjustmentObservation', 'selectedApis',
           'bootIdentityConfirmed', 'physicalOrVmConfirmed', 'units', 'samples', 'anomalies',
           'limitations', 'failedStage', 'errorType', 'windowsError'}
BASE_FIELDS = {'scope','authoritySupported','nativeExecutionPermitted','physicalCleanupVerified',
               'pid','sampleLimit','executionContext','status'}
HEADER_FIELDS = {'windowsVersion','pointerBits','ownCreationFileTime100ns','qpcFrequency',
                 'adjustmentObservation','selectedApis','bootIdentityConfirmed','physicalOrVmConfirmed','units'}
STAGES = {'load_system_kernel32','bind_readonly_apis','read_current_process_times','sample_paired_clocks'}
ERROR_TYPES = {'AttributeError','OSError','PermissionError','FileNotFoundError'}
APIS = ['GetTickCount64','QueryUnbiasedInterruptTimePrecise','GetSystemTimePreciseAsFileTime']
UNITS = {'boot':'milliseconds','work':'100ns','wall':'FILETIME-100ns-since-1601',
         'qpc':'ticks; frequency-per-second'}
LIMITATIONS = ['Sixteen back-to-back reads, not drift/error calibration.',
               'Nominal increment/resolution is not a hard uncertainty bound.',
               'No suspend, hibernation, VM freeze or migration test.',
               'No cross-process journal, SYSTEM child or socket-peer proof.',
               'Current-process birth is audit data, not an old task repair.']


def uint(value, maximum):
    return type(value) is int and 0 <= value <= maximum


def number_string(value, low=0, high=2**64-1):
    if type(value) is not str or not 1 <= len(value) <= 21:
        return False
    try:
        number = int(value)
    except ValueError:
        return False
    return str(number) == value and low <= number <= high


def exact(value, fields):
    return type(value) is dict and set(value) == set(fields)


def valid_header(value):
    version = value.get('windowsVersion')
    adjustment = value.get('adjustmentObservation')
    return (exact(version, {'major','minor','build'})
            and all(uint(v, 2**32-1) for v in version.values())
            and type(value.get('pointerBits')) is int and value['pointerBits'] in (32,64)
            and number_string(value.get('ownCreationFileTime100ns'), 1)
            and number_string(value.get('qpcFrequency'), 1, 2**63-1)
            and exact(adjustment, {'amount100ns','increment100ns','periodicAdjustmentDisabled'})
            and number_string(adjustment['amount100ns'],0,2**32-1)
            and number_string(adjustment['increment100ns'],0,2**32-1)
            and type(adjustment['periodicAdjustmentDisabled']) is bool
            and value.get('selectedApis') == APIS and value.get('units') == UNITS
            and value.get('bootIdentityConfirmed') is False
            and value.get('physicalOrVmConfirmed') is False)


def valid_success(value):
    if not exact(value, BASE_FIELDS | HEADER_FIELDS | {'samples','anomalies','limitations'}) or not valid_header(value):
        return False
    if type(value['samples']) is not list or len(value['samples']) > 16:
        return False
    fields = {'sequence','qpcBefore','qpcAfter','bootBeforeMs','bootAfterMs','work100ns','wallBefore100ns','wallAfter100ns'}
    for sequence, row in enumerate(value['samples'], 1):
        if not exact(row, fields) or type(row['sequence']) is not int or row['sequence'] != sequence:
            return False
        if not all(number_string(row[k], -(2**63), 2**63-1) for k in ('qpcBefore','qpcAfter')):
            return False
        if not all(number_string(row[k]) for k in fields - {'sequence','qpcBefore','qpcAfter'}):
            return False
    return (type(value['anomalies']) is list and len(value['anomalies']) <= 17
            and all(type(v) is str and v in {'survey_elapsed_over_2s','counter_regression_in_bracket'}
                    for v in value['anomalies']) and value['limitations'] == LIMITATIONS)


def classify(raw):
    try:
        value = json.loads(raw.decode('utf-8-sig'))
    except UnicodeError:
        return {'classification': 'invalid_utf8'}, None
    except json.JSONDecodeError as error:
        return {'classification': 'not_json', 'errorLine': error.lineno, 'errorColumn': error.colno}, None
    if not isinstance(value, dict) or set(value) - ALLOWED:
        return {'classification': 'non_whitelisted_shape'}, None
    if (value.get('scope') != 'readonly-clock-observation'
            or any(value.get(k) is not False for k in (
                'authoritySupported', 'nativeExecutionPermitted', 'physicalCleanupVerified'))):
        return {'classification': 'unexpected_scope_or_permission'}, None
    status = value.get('status')
    if (not uint(value.get('pid'),2**32-1) or value['pid'] == 0
            or type(value.get('sampleLimit')) is not int or value['sampleLimit'] != 16
            or value.get('executionContext') != 'inherited-SSH-user; not a SYSTEM worker test'
            or type(status) is not str):
        return {'classification':'invalid_field_type_or_value'}, None
    if status == 'observed_not_authority':
        if not valid_success(value):
            return {'classification':'invalid_field_type_or_value'}, None
        return {'classification': 'observed_not_authority'}, value
    if status == 'unsupported_platform':
        if not exact(value, BASE_FIELDS):
            return {'classification':'invalid_field_type_or_value'}, None
        return {'classification':'observed_unsupported_or_api_failure'}, value
    if status == 'unsupported_api_or_read_failure':
        stage = value.get('failedStage')
        expected = BASE_FIELDS | {'failedStage','errorType','windowsError'}
        if stage == 'sample_paired_clocks':
            expected |= HEADER_FIELDS
        if (not exact(value, expected) or type(stage) is not str or stage not in STAGES
                or type(value.get('errorType')) is not str or value['errorType'] not in ERROR_TYPES
                or not uint(value.get('windowsError'),2**32-1)
                or (stage == 'sample_paired_clocks' and not valid_header(value))):
            return {'classification':'invalid_field_type_or_value'}, None
        return {'classification': 'observed_unsupported_or_api_failure',
                'failedStage': value.get('failedStage'), 'errorType': value.get('errorType'),
                'windowsError': value.get('windowsError')}, value
    return {'classification': 'unknown_status'}, None


def main():
    if sys.argv[1:] != ['--execute-reviewed-clock-once']:
        raise SystemExit('explicit_clock_supplement_required')
    receipt_file, body_file = HERE / 'CLOCK_SUPPLEMENT_RECEIPT.json', HERE / 'CLOCK_SUPPLEMENT_BODY.json'
    if receipt_file.exists() or body_file.exists():
        raise SystemExit('supplement_already_attempted_no_retry')
    original = HERE / 'EXECUTION_RECEIPT.json'
    if not original.exists():
        raise SystemExit('original_attempt_required')
    path = 'verification/wecom-windows-survey-20261102/windows_clock_survey.py'
    source = subprocess.check_output(['git', '-C', str(ROOT), 'show', BASE + ':' + path])
    if hashlib.sha256(source).hexdigest() != APPROVED['windows_clock_survey.py']:
        raise SystemExit('reviewed_source_hash_mismatch')
    receipt = {'atUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'originalReceiptSha256': hashlib.sha256(original.read_bytes()).hexdigest(),
               'sourceCommit': BASE, 'sourceSha256': APPROVED['windows_clock_survey.py'],
               'scope': 'clock-only read-only supplement; separately reviewed; no metadata retry',
               'phoneActions': 0, 'adbClientCalls': 0, 'productionConfigChanges': 0, 'nativeAcceptance': False}
    with receipt_file.open('x') as file:
        json.dump(receipt, file, indent=2)
    received, transport = bounded(r'D:\PhoneCloud\tools\python39\python.exe -I -B - --observe', source)
    receipt.update(transport, stdoutSha256=hashlib.sha256(received['stdout']).hexdigest())
    # Retain transport evidence BEFORE decoding or invoking any classification.
    receipt_file.write_text(json.dumps(receipt, indent=2) + '\n')
    if transport['failure'] or transport['exitCode']:
        receipt['classification'] = 'unconfirmed_transport'
    else:
        result, value = classify(received['stdout'])
        receipt.update(result)
        if value is not None:
            with body_file.open('x') as file:
                file.write(json.dumps(value, indent=2, ensure_ascii=True) + '\n')
    receipt['completedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt_file.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)
    if receipt['classification'] != 'observed_not_authority':
        raise SystemExit('stopped_with_recorded_failure_no_retry')


if __name__ == '__main__':
    main()
