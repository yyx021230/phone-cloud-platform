"""Proof-based cleanup of one leased reader; callbacks never manage ADB."""
MAIN = 'com.netease.open.pocoservice'
TEST = MAIN + '.test'
ABSENT = '__WECOM_PID_ABSENT_V1__'


def pid_command(package):
    if package not in (MAIN, TEST): raise ValueError('invalid_reader_package')
    return ('pidof ' + package + '; code=$?; if [ "$code" -eq 1 ]; then echo ' + ABSENT
            + '; elif [ "$code" -ne 0 ]; then echo __WECOM_PID_ERROR_V1__; fi')


def parse_pids(raw):
    import re
    if not isinstance(raw, str): raise ValueError('invalid_pid_proof')
    text = raw.strip()
    if text == ABSENT: return []
    if not re.fullmatch(r'[1-9]\d*(?:\s+[1-9]\d*)*', text):
        raise ValueError('invalid_pid_proof')
    return text.split()


def cleanup_reader(*, serial, ports, owned_pid, owned_start, reader_started,
                   pids, start_token, stop_main, close_instrument,
                   forwards, remove_forward):
    """Return proof, not command ACK. Never stop a replacement reader/forward."""
    ok = True
    if reader_started:
        try:
            current = pids(MAIN)
            if current:
                if (not owned_pid or not owned_start or current != [owned_pid]
                        or start_token(owned_pid) != owned_start):
                    ok = False
                else:
                    answer = stop_main()
                    if not isinstance(answer, str) or any(word in answer.lower()
                            for word in ('error', 'exception', 'permission denial', 'failure')):
                        ok = False
        except Exception:
            ok = False
    try:
        close_instrument()
    except Exception:
        ok = False

    # A local port is globally unique. If it was replaced, do not delete it,
    # even if a host-serial command would accept that local port number.
    if ports:
        try:
            if len({port for port, _ in ports}) != len(ports):
                raise ValueError('duplicate_owned_forward')
            observed = forwards()
            for port, remote in ports:
                matches = [entry for entry in observed if entry[1] == 'tcp:' + str(port)]
                expected = (serial, 'tcp:' + str(port), 'tcp:' + str(remote))
                if not matches:
                    continue
                if matches != [expected]:
                    ok = False
                    continue
                remove_forward(port)
            remaining = forwards()  # Fresh read AFTER removal, never an ACK.
            if any(entry[1] in {'tcp:' + str(port) for port, _ in ports} for entry in remaining):
                ok = False
        except Exception:
            ok = False
    if reader_started:
        try:
            # Stopping the main package is not proof its test package stopped.
            remaining_main, remaining_test = pids(MAIN), pids(TEST)
            if remaining_main or remaining_test:
                ok = False
        except Exception:
            ok = False
    return ok
