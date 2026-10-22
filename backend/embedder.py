"""Optional embedding-service compatibility port.

Myelin owns the model/index/representation implementation. SwarmLock adds
semantic overlap policy. Missing products raise explicitly; this module never
reports an indexing operation or empty search as a successful substitute.
"""
from extension_host import (
    ExtensionUnavailable as _ExtensionUnavailable,
    available as _extension_available,
    load_legacy_namespace as _load_extension_namespace,
)


async def _unavailable_memory(*args, **kwargs):
    raise _ExtensionUnavailable("myelin")


def _unavailable_representation(*args, **kwargs):
    raise _ExtensionUnavailable("myelin")


async def _unavailable_overlap(*args, **kwargs):
    raise _ExtensionUnavailable("swarmlock")


_get_model = _get_reranker = _unavailable_memory
embed = embed_batch = rerank = _unavailable_memory
store_embedding = search_similar = _unavailable_memory
embed_task = embed_digest = embed_knowledge = _unavailable_memory
embed_guideline = remove_guideline_embedding = _unavailable_memory
_cosine = task_dense_text = digest_dense_text = _unavailable_representation
knowledge_dense_text = guideline_dense_text = _unavailable_representation
check_overlap = _unavailable_overlap

if _extension_available("myelin"):
    _load_extension_namespace(globals(), "myelin", "backend/embedder.py")

if _extension_available("swarmlock"):
    _load_extension_namespace(globals(), "swarmlock", "backend/embedding_overlap.py")
