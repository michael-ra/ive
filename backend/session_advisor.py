"""Optional recommendation lifecycle port; manual guidelines belong to IVE.

No intent representations, scoring anchors, ranking or storage live here.
Inactive lifecycle notifications are harmless; explicit operations are guarded
by their API entry points and must not report analysis that did not happen.
"""
from extension_host import available, load_legacy_namespace


async def update_intent(*args, **kwargs):
    return None


async def analyze_session(*args, **kwargs):
    return None


def clear_intent(*args, **kwargs):
    return None


if available("myelin"):
    load_legacy_namespace(globals(), "myelin", "backend/session_advisor.py")
