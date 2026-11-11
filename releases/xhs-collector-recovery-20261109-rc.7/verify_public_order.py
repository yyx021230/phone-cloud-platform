"""Verify the returned order using the collector's public-title projection."""
import hashlib
import json
import re


def verify_public_order(collection):
    events = collection.get('recovery_events', [])
    if (collection.get('complete') is not True or
            events.count('collection_integrity:verified_two_pass') != 1 or
            events.count('collection_public_identity:prefix178_utf16_v1') != 1):
        return False

    def value(prefix):
        matched = [event[len(prefix):] for event in events if event.startswith(prefix)]
        return matched[0] if len(matched) == 1 else ''

    first = value('collection_primary_sha256:')
    second = value('collection_verification_sha256:')
    if first != second or not re.fullmatch('[0-9a-f]{64}',first):
        return False
    notes = collection.get('notes')
    if not isinstance(notes,list) or any(value(tag)!=str(len(notes)) for tag in (
            'collection_primary_count:', 'collection_verification_count:')):
        return False
    use_cover = 'collection_identity_schema:title_date_cover_sha256_v1' in events
    try:
        keys = []
        for note in notes:
            title = note['title'].encode('utf-16-le','surrogatepass')[:356].decode('utf-16-le','ignore')
            key = (title,note['published_date'])
            if use_cover and note.get('element_cover_sha256'):
                key += (note['element_cover_sha256'],)
            keys.append(key)
        if len(keys) != len(set(keys)):
            return False
        digest = hashlib.sha256(json.dumps(keys,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    except (KeyError,AttributeError,TypeError,UnicodeError):
        return False
    return digest == value('collection_public_sha256:')
